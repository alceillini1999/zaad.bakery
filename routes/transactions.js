const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// Add transaction
router.post('/', async (req, res) => {
    try {
        const { paymentMethod, cashBreakdown } = req.body;
        let total = 0;
        for (let note in cashBreakdown) {
            total += (parseInt(note) * (cashBreakdown[note] || 0));
        }
        const transaction = new Transaction({ paymentMethod, cashBreakdown, total });
        await transaction.save();
        res.json(transaction);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all transactions
router.get('/', async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ date: -1 });
        res.json(transactions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;