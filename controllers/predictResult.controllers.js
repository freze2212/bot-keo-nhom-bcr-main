const mongoose = require('mongoose')
require('dotenv').config()
const jwt = require('jsonwebtoken');

const { predictResultSchema } = require('../config/schema/index.schema')
const { calculateGroupThreeSeries, getCurrentTime } = require('../utilities/helper')
const { calculator_1, calculator_2, calculator_3, calculator_4, calculator_5 } = require('../utilities/analyzeFixedRoundsSexy')

class predictResultControllers {
    async getOne(req, res) {
        try {
            const { tableName } = req.query;
            if (!tableName) return res.status(400).json({});
            const table = await predictResultSchema.findOne({ tableName }).select("-_id -tableID -__v")
            if (!table) return res.status(403).json({});
            const groupRoad = calculateGroupThreeSeries(table.totalRound);

            return res.status(200).json({
                ...table.toObject(),
                timeCurrent: getCurrentTime().timeUnix,
                ai0: {
                    groupRoad: groupRoad.adjustGroupWin,
                    percentCurrent: table.percentCurrent,
                },
                ai1: {
                    groupRoad: groupRoad.adjustGroupWin,
                    percentCurrent: calculator_1(table.totalRound).percentCurrent,
                },
                ai2: {
                    groupRoad: groupRoad.adjustGroupWin,
                    percentCurrent: calculator_2(table.totalRound).percentCurrent,
                },
                ai3: {
                    groupRoad: groupRoad.adjustGroupWin,
                    percentCurrent: calculator_3(table.totalRound).percentCurrent,
                },
                ai4: {
                    groupRoad: groupRoad.adjustGroupWin,
                    percentCurrent: calculator_4(table.totalRound).percentCurrent,
                },
                ai5: {
                    groupRoad: groupRoad.adjustGroupWin,
                    percentCurrent: calculator_5(table.totalRound).percentCurrent,
                },
                // ai1: calculator_1(table.totalRound),
                // ai2: calculator_2(table.totalRound),
                // ai3: calculator_3(table.totalRound),
                // ai4: calculator_4(table.totalRound),
                // ai5: calculator_5(table.totalRound),
            });
        } catch (error) {
            res.status(500).json({});
            console.error(error);
        }
    }

    async getAll(req, res) {
        try {
            const tableList = await predictResultSchema.aggregate([
                { $addFields: { lastStamp: { $max: "$totalRound.stampTime" } } },
                { $sort: { tableName: 1, lastStamp: -1, _id: -1 } },
                {
                    $group: {
                        _id: "$tableName",
                        tableName: { $first: "$tableName" },
                        dealerImage: { $first: "$dealerImage" },
                        percentCurrent: { $first: "$percentCurrent" },
                        roundStats: { $first: "$roundStats" },
                        shuffle: { $first: "$shuffle" },
                        maintenance: { $first: "$maintenance" },
                    },
                },
                {
                    $project: {
                        _id: 0,
                        tableName: 1,
                        dealerImage: 1,
                        percentCurrent: 1,
                        roundStats: 1,
                        shuffle: 1,
                        maintenance: 1,
                    },
                },
            ]);
            if (tableList.length < 1) return res.status(200).json([]);
            return res.status(200).json(tableList);
        } catch (error) {
            res.status(500).json({});
            console.error(error);
        }
    }

    verifyJWT(req, res, next) {
        try {
            // Support authentication via API key (Header: x-api-key / x-api-token or Query: api_key / apiKey)
            const apiKey = req.headers['x-api-key'] || req.headers['x-api-token'] || req.query?.api_key || req.query?.apiKey;
            const validApiKey = process.env.API_KEY || process.env.STATIC_API_KEY;

            if (apiKey && validApiKey && apiKey === validApiKey) {
                req.user = { isApiKey: true };
                return next();
            }

            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'Authorization' });

            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded;

            next();
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Authorization' });
            }
            console.error('JWT lỗi:', err.message);
            return res.status(401).json({ message: 'Authorization' });
            // return res.status(500).json({ message: 'Server error' });
        }
    }

}



module.exports = new predictResultControllers