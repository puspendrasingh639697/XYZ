const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Message = require('../models/Message');

// Test route
router.get('/', (req, res) => {
    res.json({ message: 'Chat API Working' });
});

// Register user
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const user = new User({ username, email, password });
        await user.save();
        res.json({ 
            success: true, 
            user: { id: user._id, username, email } 
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Get all users
router.get('/users', async (req, res) => {
    try {
        const users = await User.find().select('username email isOnline');
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get messages
router.get('/messages/:user1/:user2', async (req, res) => {
    try {
        const messages = await Message.find({
            $or: [
                { sender: req.params.user1, receiver: req.params.user2 },
                { sender: req.params.user2, receiver: req.params.user1 }
            ]
        }).sort({ timestamp: 1 });
        res.json({ success: true, messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;