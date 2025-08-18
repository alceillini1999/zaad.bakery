const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    paymentMethod: { type: String, enum: ['Cash', 'Phone', 'Buy Goods', 'Withdraw Cash'], required: true },
    cashBreakdown: {
        "1000": Number,
        "500": Number,
        "200": Number,
        "100": Number,
        "50": Number,
        "40": Number,
        "20": Number,
        "10": Number,
        "5": Number,
        "1": Number
    },
    total: Number
});

module.exports = mongoose.model('Transaction', transactionSchema);