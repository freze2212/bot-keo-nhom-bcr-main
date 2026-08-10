const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ExplodeSchema = new Schema({
    name: { type: String },
    typeGame: { type: String },
    percent: { type: Number },
    time: { type: Number },
    typeTurn: { type: String },
}, { 
    timestamps: true 
});


module.exports = mongoose.model('explode', ExplodeSchema);