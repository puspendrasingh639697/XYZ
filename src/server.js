
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();

// Initialize
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    } 
});

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB (SIMPLIFIED - NO DEPRECATED OPTIONS)
mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/livechat");

const db = mongoose.connection;
db.on("error", (error) => {
    console.log("❌ MongoDB connection error:", error.message);
    console.log("ℹ️  Starting without database... Messages will be saved in memory only.");
});
db.once("open", () => {
    console.log("✅ MongoDB Connected");
});

// Create Message Schema
const messageSchema = new mongoose.Schema({
    sender: String,
    receiver: String,
    content: String,
    timestamp: { type: Date, default: Date.now },
    delivered: { type: Boolean, default: false },
    read: { type: Boolean, default: false }
});

const Message = mongoose.model("Message", messageSchema);

// Store online users
const users = {};

// ========== API ROUTES ==========

// Home route
app.get("/", (req, res) => {
    res.json({ 
        message: "Live Chat API",
        version: "2.1",
        features: ["WebSocket", "Database", "Multiple Users"],
        endpoints: {
            register: "POST /api/chat/register",
            users: "GET /api/chat/users",
            messages: "GET /api/chat/messages/:user1/:user2",
            allMessages: "GET /api/chat/all-messages"
        },
        socket: "WebSocket active on /socket.io"
    });
});

// Register user (Simple version)
app.post("/api/chat/register", (req, res) => {
    try {
        const { username, email } = req.body;
        
        if (!username || !email) {
            return res.status(400).json({ 
                success: false, 
                error: "Username and email required" 
            });
        }
        
        const userId = "user_" + Date.now();
        
        res.json({
            success: true,
            message: "User registered successfully",
            user: { 
                id: userId, 
                username, 
                email,
                joined: new Date().toISOString()
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all users
app.get("/api/chat/users", (req, res) => {
    const onlineUsers = Object.values(users).map(user => ({
        username: user.username,
        socketId: user.socketId,
        joined: user.joined
    }));
    
    res.json({
        success: true,
        users: onlineUsers,
        count: onlineUsers.length,
        timestamp: new Date().toISOString()
    });
});

// Get messages between users (FROM DATABASE)
app.get("/api/chat/messages/:user1/:user2", async (req, res) => {
    try {
        const { user1, user2 } = req.params;
        
        // Check if MongoDB is connected
        if (mongoose.connection.readyState !== 1) {
            return res.json({
                success: true,
                user1: user1,
                user2: user2,
                messageCount: 0,
                messages: [],
                note: "Database not connected - showing demo messages",
                demoMessages: [
                    { 
                        id: "demo1",
                        from: user1, 
                        to: user2, 
                        text: "Hello! How are you?", 
                        time: new Date(Date.now() - 60000).toISOString() 
                    },
                    { 
                        id: "demo2",
                        from: user2, 
                        to: user1, 
                        text: "I am good! What about you?", 
                        time: new Date(Date.now() - 30000).toISOString() 
                    }
                ]
            });
        }
        
        // Get messages from database
        const messages = await Message.find({
            $or: [
                { sender: user1, receiver: user2 },
                { sender: user2, receiver: user1 }
            ]
        }).sort({ timestamp: 1 }).limit(100);
        
        res.json({
            success: true,
            user1: user1,
            user2: user2,
            messageCount: messages.length,
            messages: messages.map(msg => ({
                id: msg._id,
                from: msg.sender,
                to: msg.receiver,
                text: msg.content,
                time: msg.timestamp,
                delivered: msg.delivered,
                read: msg.read
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all messages (for testing)
app.get("/api/chat/all-messages", async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.json({
                success: true,
                totalMessages: 0,
                recentMessages: [],
                note: "Database not connected"
            });
        }
        
        const messages = await Message.find().sort({ timestamp: -1 }).limit(50);
        res.json({
            success: true,
            totalMessages: await Message.countDocuments(),
            recentMessages: messages
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== SOCKET.IO EVENTS ==========

io.on("connection", (socket) => {
    console.log("🔗 New connection:", socket.id);
    
    // Send connection ID to client
    socket.emit("connected", { 
        socketId: socket.id,
        message: "Connected to chat server",
        serverTime: new Date().toISOString()
    });
    
    // User joins with username
    socket.on("join", (username) => {
        if (!username) {
            socket.emit("error", { error: "Username required" });
            return;
        }
        
        users[socket.id] = {
            username: username,
            socketId: socket.id,
            joined: new Date().toISOString()
        };
        
        console.log("👤 User joined:", username, "| Total users:", Object.keys(users).length);
        
        // Welcome message to this user
        socket.emit("welcome", {
            message: `Welcome ${username}! You are now connected.`,
            yourUsername: username,
            onlineUsers: Object.values(users).map(u => u.username)
        });
        
        // Notify other users
        socket.broadcast.emit("user-joined", {
            username: username,
            totalUsers: Object.keys(users).length
        });
        
        // Update users list for everyone
        io.emit("users-update", {
            users: Object.values(users).map(u => u.username),
            count: Object.keys(users).length,
            timestamp: new Date().toISOString()
        });
    });
    
    // Send message to specific user (WITH DATABASE SAVING)
    socket.on("send-message", async (data) => {
        const { to, message } = data;
        const fromUser = users[socket.id];
        
        if (!fromUser) {
            socket.emit("error", { error: "Please join first using 'join' event" });
            return;
        }
        
        if (!to || !message) {
            socket.emit("error", { error: "Recipient and message required" });
            return;
        }
        
        console.log(`💬 ${fromUser.username} → ${to}: ${message}`);
        
        // ✅✅✅ SAVE MESSAGE TO DATABASE (if connected)
        let savedMessage = null;
        if (mongoose.connection.readyState === 1) {
            try {
                const newMessage = new Message({
                    sender: fromUser.username,
                    receiver: to,
                    content: message,
                    timestamp: new Date(),
                    delivered: false,
                    read: false
                });
                
                savedMessage = await newMessage.save();
                console.log(`💾 Message saved to database: ${savedMessage._id}`);
                
            } catch (dbError) {
                console.error("❌ Database save error:", dbError.message);
            }
        } else {
            console.log("⚠️  Database not connected - message saved in memory only");
        }
        
        // Find recipient socket
        let recipientSocketId = null;
        for (const [sockId, user] of Object.entries(users)) {
            if (user.username === to) {
                recipientSocketId = sockId;
                break;
            }
        }
        
        // Message data
        const messageData = {
            id: savedMessage ? savedMessage._id.toString() : "mem_" + Date.now(),
            from: fromUser.username,
            to: to,
            message: message,
            timestamp: new Date().toISOString(),
            delivered: !!recipientSocketId,
            savedToDatabase: !!savedMessage
        };
        
        // Send to recipient if online
        if (recipientSocketId) {
            io.to(recipientSocketId).emit("new-message", messageData);
            
            // Update delivery status in database
            if (savedMessage) {
                await Message.findByIdAndUpdate(savedMessage._id, { delivered: true });
            }
        }
        
        // Send confirmation to sender
        socket.emit("message-sent", {
            ...messageData,
            status: recipientSocketId ? "delivered" : "sent (user offline)"
        });
    });
    
    // Mark message as read
    socket.on("mark-read", async (data) => {
        try {
            const { messageId } = data;
            if (mongoose.connection.readyState === 1 && messageId.startsWith("mem_") === false) {
                await Message.findByIdAndUpdate(messageId, { 
                    read: true,
                    readAt: new Date() 
                });
                console.log(`📖 Message marked as read: ${messageId}`);
            }
        } catch (error) {
            console.error("Mark read error:", error.message);
        }
    });
    
    // Send message to all users (broadcast)
    socket.on("broadcast-message", async (message) => {
        const fromUser = users[socket.id];
        
        if (!fromUser) {
            socket.emit("error", { error: "Please join first" });
            return;
        }
        
        console.log(`📢 ${fromUser.username} broadcast: ${message}`);
        
        // Save broadcast to database
        if (mongoose.connection.readyState === 1) {
            try {
                const broadcastMsg = new Message({
                    sender: fromUser.username,
                    receiver: "ALL",
                    content: message,
                    type: "broadcast"
                });
                await broadcastMsg.save();
            } catch (error) {
                console.error("Broadcast save error:", error.message);
            }
        }
        
        const broadcastData = {
            from: fromUser.username,
            message: message,
            timestamp: new Date().toISOString(),
            type: "broadcast"
        };
        
        // Send to everyone including sender
        io.emit("broadcast", broadcastData);
    });
    
    // Typing indicator
    socket.on("typing", (data) => {
        const { to, isTyping } = data;
        const fromUser = users[socket.id];
        
        if (fromUser && to) {
            // Find recipient
            for (const [sockId, user] of Object.entries(users)) {
                if (user.username === to) {
                    io.to(sockId).emit("user-typing", {
                        from: fromUser.username,
                        isTyping: isTyping,
                        timestamp: new Date().toISOString()
                    });
                    break;
                }
            }
        }
    });
    
    // Disconnect handler
    socket.on("disconnect", () => {
        const user = users[socket.id];
        
        if (user) {
            console.log("❌ User disconnected:", user.username);
            
            // Remove from users
            delete users[socket.id];
            
            // Notify other users
            socket.broadcast.emit("user-left", {
                username: user.username,
                totalUsers: Object.keys(users).length,
                timestamp: new Date().toISOString()
            });
            
            // Update users list
            io.emit("users-update", {
                users: Object.values(users).map(u => u.username),
                count: Object.keys(users).length,
                timestamp: new Date().toISOString()
            });
        }
    });
});

// ========== START SERVER ==========

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log("=".repeat(50));
    console.log("🚀 LIVE CHAT SERVER STARTED (VERSION 2.1)");
    console.log("=".repeat(50));
    console.log(`🌐 HTTP API:    http://localhost:${PORT}`);
    console.log(`📡 WebSocket:   ws://localhost:${PORT}`);
    console.log(`🗄️  Database:    ${mongoose.connection.readyState === 1 ? "✅ Connected" : "⚠️  Not connected (running in memory mode)"}`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log("=".repeat(50));
    console.log("📋 Available Endpoints:");
    console.log(`   GET  /                        - API Info`);
    console.log(`   POST /api/chat/register       - Register user`);
    console.log(`   GET  /api/chat/users          - Get online users`);
    console.log(`   GET  /api/chat/messages/:u1/:u2 - Get messages from DB`);
    console.log(`   GET  /api/chat/all-messages   - Get all messages`);
    console.log("=".repeat(50));
    console.log("⚡ Server ready for connections...");
});
