const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PercentCurrentSchema = new Schema({
    Player: Number,
    Tier: Number,
    Banker: Number,
    Round: String,
    Forecast: Number,
}, { _id: false });

const RoundStatsSchema = new Schema({
    player: { type: Number, default: 0 },
    tie: { type: Number, default: 0 },
    banker: { type: Number, default: 0 },
    source: { type: String, enum: ['api', 'computed'], default: 'computed' },
}, { _id: false });

const TotalRoundItemSchema = new Schema({
    id: { type: Number, required: false },
    stampTime: { type: Number, required: true },
    showX: { type: Number, required: true },
    showY: { type: Number, required: true },
    count: { type: Number, required: true },
    road: { type: Number, required: true },
    win: { type: Boolean, required: true },
    roadFormat: { type: String, required: true },
    roadRandom: { type: String, required: false },
}, { _id: false });

const PredictResultSchema = new Schema({
    tableName: { type: String, required: true },
    tableID: { type: Number, required: true },
    maintenance: { type: Number, required: true },
    dealerImage: { type: String, required: false },
    // eventType: { type: String, required: true },
    // gameRound: { type: String, required: true },
    iTime: { type: Number, required: true },
    roundStartTime: { type: Number, required: true },
    shuffle: { type: Number, required: true },
    statusGame: { type: String, required: true },
    // countDownUnix: { type: Number, required: true },
    // percentPre: { type: Number, required: false },
    percentCurrent: { type: PercentCurrentSchema, required: false },
    /** Tổng P/Hòa/B — sync từ winCounts API hoặc đếm bigRoads */
    roundStats: { type: RoundStatsSchema, required: false },
    /** Raw winCounts từ roadInfo API gốc */
    winCounts: { type: Schema.Types.Mixed, required: false },
    totalRound: {
        type: [TotalRoundItemSchema],
        default: [],
    }
});

PredictResultSchema.index({ tableName: 1 }, { unique: true });

module.exports = mongoose.model('predictResult', PredictResultSchema);
