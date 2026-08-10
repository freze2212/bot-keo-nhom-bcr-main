const mongoose = require('mongoose');
require('dotenv').config();
const jwt = require('jsonwebtoken');

const { explodeSchema } = require('../config/schema/index.schema');
const { formatUnixTime, getCurrentTime } = require('../utilities/helper');

class explodeNHControllers {
    async insertGameNH_Dev(req, res) {
        try {
            // const { name, typeGame } = req.body;

            // if (!name || !typeGame) {
            //     return res.status(400).json({
            //         success: false,
            //         message: 'Missing required fields: name or typeGame'
            //     });
            // }

            let arr = ["Folsom Prison","Karen Maneater","Little Bighorn","Remember Gulag","Road Rage","The Border"]

            console.log(arr.length)
            for (let i = 0; i < arr.length; i++) {
                const newExplode = new explodeSchema({
                    name: arr[i],
                    typeGame: 'NOLIMIT',
                    time: 0,
                    percent: 0,
                });
                await newExplode.save();
            }

            return res.status(201).json(arr);

        } catch (error) {
            console.error('Error creating record:', error);
            return res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    }


    async getListTableByGroup(req, res) {
        try {
            const { typeGame } = req.query;
            if (!typeGame) return res.status(400).json([]);
            // await explodeSchema.updateMany({},{percent: 0, time: 0} )

            let gameList = await explodeSchema.find({ typeGame })
                .select("-__v -updatedAt")
                .sort({ createdAt: 1 })
                .lean();

            gameList = await this._checkUpdateData(gameList)

            gameList = gameList
                .map(item => ({
                    ...item,
                    time: `${formatUnixTime(item.time)} - ${formatUnixTime(item.time + 360000)}`
                }))
                .sort((a, b) => a.createdAt - b.createdAt)
                .map(({ createdAt, ...rest }) => rest);

            return res.status(200).json(gameList)
        } catch (error) {
            res.status(500).json([]);
            console.error(error);
        }
    }

    async getTableById(req, res) {
        try {
            const { id } = req.query;
            if (!id) return res.status(400).json({});
            let game = await explodeSchema.findOne({ _id: id })
                .select("-_id -__v -updatedAt -createdAt")
                .lean();
            if(game) {
                game.time = `${formatUnixTime(game.time)} - ${formatUnixTime(game.time + 360000)}`
            } else{
                game = {}
            }
            return res.status(200).json(game)
        } catch (error) {
            res.status(500).json({});
            console.error(error);
        }
    }

    async _checkUpdateData(dataList) {
        try {
            if (!Array.isArray(dataList) || dataList.length < 1) return [];
            let dataFilter = []
            for (let i = 0; i < dataList.length; i++) {
                dataList[i].createdAt = new Date(dataList[i].createdAt).getTime()
                let item = dataList[i]
                const isTime = this._checkTimeRound(item.time)
                if (isTime.change) {
                    let newDataUpdate = {
                        time: isTime.timeUnix,
                        percent: this._randomPercent(),
                    }
                    console.log(newDataUpdate)
                    await this._updateOneGame(item.name, newDataUpdate)
                    dataFilter.push({
                        ...newDataUpdate,
                        createdAt: item.createdAt,
                        typeGame: item.typeGame,
                        name: item.name,
                    })
                } else {
                    dataFilter.push(item)
                }
            }
            return dataFilter;
        } catch (error) {
            console.error(error)
        }
    }

    async _updateOneGame(nameGame, update) {
        try {
            if (!nameGame) return;
            await explodeSchema.updateOne({ name: nameGame }, update)
        } catch (error) {
            console.error(error)
        }
    }

    // 30% (20->40)
    // 70% (41->99)
    _randomPercent() {
        const rand = Math.random();
        if (rand < 0.3) {
            return Math.floor(Math.random() * (40 - 20 + 1)) + 20;
        } else {
            return Math.floor(Math.random() * (99 - 41 + 1)) + 41;
        }
    }

    _checkTimeRound(timeUnix) {
        const timeCurrent = getCurrentTime().timeUnix;
        if (timeCurrent < timeUnix) return { change: 0, timeUnix }
        timeUnix = this._randomUnixFromNow()
        return { change: 1, timeUnix };
    }

    _randomUnixFromNow(minMinutes = 7, maxMinutes = 30) {
        const now = getCurrentTime().timeUnix;
        const minOffset = minMinutes * 60 * 1000;
        const maxOffset = maxMinutes * 60 * 1000;
        const randomOffset = Math.floor(Math.random() * (maxOffset - minOffset + 1)) + minOffset;

        return now + randomOffset;
    }
}

module.exports = new explodeNHControllers();