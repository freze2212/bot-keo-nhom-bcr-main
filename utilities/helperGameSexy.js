const isEqual = require('lodash.isequal');
require('dotenv').config();

const { predictResultSchema } = require('../config/schema/index.schema')
const {
    getCurrentTime,
    sortByStampTimeDesc,
    calculateGroupThreeSeries,
    calculateWinningPercentage,
    getRandomInRange,
    getRandomPercentages,
    checkWhoWinRound,
    currentGameStatus,
    appendToLog,
} = require('./helper');
const { resolveRoundStats } = require('./baccaratBigRoad');
const { calculator_1, calculator_2 } = require('./analyzeFixedRoundsSexy');

const SERVER_VERBOSE_LOG = process.env.SERVER_VERBOSE_LOG === 'true';
const MAX_TOTAL_ROUNDS_PER_TABLE =
    Number(process.env.MAX_TOTAL_ROUNDS_PER_TABLE) || 400;

function verboseLog(...args) {
    if (SERVER_VERBOSE_LOG) console.log(...args);
}

/** percentCurrent từ thuật toán cầu (không random). */
function buildRoadPercentCurrent(totalRoundDB) {
    const rounds = Array.isArray(totalRoundDB) ? totalRoundDB.flat() : [];
    const flat = rounds.filter((r) => r && (r.roadFormat || r.road != null));
    try {
        const a1 = calculator_1(flat);
        const a2 = calculator_2(flat);
        const pc1 = a1?.percentCurrent || {};
        const pc2 = a2?.percentCurrent || {};
        const vote = { B: 0, P: 0 };
        for (const pc of [pc1, pc2]) {
            const r = String(pc.Round || "").toUpperCase();
            if (r.startsWith("B")) vote.B += 1;
            else if (r.startsWith("P")) vote.P += 1;
        }
        // Streak bias từ 8 tay gần nhất
        const bp = flat
            .slice()
            .sort((a, b) => Number(a.stampTime) - Number(b.stampTime))
            .map((r) => {
                if (r.roadFormat === "B" || r.roadFormat === "P") return r.roadFormat;
                return checkWhoWinRound(r.road);
            })
            .filter((s) => s === "B" || s === "P");
        const tail = bp.slice(-8);
        if (tail.length >= 2) {
            let streak = 1;
            for (let i = tail.length - 2; i >= 0; i--) {
                if (tail[i] === tail[tail.length - 1]) streak += 1;
                else break;
            }
            if (streak >= 2) vote[tail[tail.length - 1]] += 1.5;
            // chop
            const flips = tail
                .slice(1)
                .filter((s, i) => s !== tail[i]).length;
            if (flips >= tail.length - 1) {
                const opp = tail[tail.length - 1] === "B" ? "P" : "B";
                vote[opp] += 1.2;
            }
        }
        const round = vote.B >= vote.P ? "B" : "P";
        const banker = round === "B" ? Math.max(pc1.Banker || 55, 55) : Math.min(pc1.Banker || 35, 45);
        const player = 100 - banker - Math.max(2, Math.min(12, pc1.Tier || 6));
        const tier = 100 - banker - player;
        const forecast = Math.max(
            66,
            Math.min(96, Number(pc1.Forecast) || 72)
        );
        return {
            Player: Math.max(0, player),
            Banker: Math.max(0, banker),
            Tier: Math.max(0, tier),
            Round: round,
            Forecast: forecast,
        };
    } catch (_) {
        return getRandomPercentages();
    }
}

function filterData(data = []) {
    return data.map(item => {
        // const bigRoads = [...(item?.roadInfo?.bigRoads ?? [])].sort((a, b) => b.stampTime - a.stampTime);
        const bigRoads = [...(item?.roadInfo?.bigRoads ?? [])]
            .sort((a, b) => b.stampTime - a.stampTime)
            .map((item, index, array) => ({
                ...item,
                id: array.length - index
            }));
        let currentGame = currentGameStatus(item)

        return {
            tableInfo: {
                stampTime: item.tableInfo.stampTime,
                tableID: item.tableInfo.tableID,
                tableName: item.tableInfo.tableName,
                maintenance: item.tableInfo.maintenance,
                dealerImage: item.tableInfo.dealerImage
                    ? `https://vcnh2k.gklam.com/images/player/dealers/png/${item.tableInfo.dealerImage}`
                    : null,
                // newGame: item.tableInfo.newGame,
            },
            dealerEvent: {
                eventType: item.dealerEvent.eventType,
                gameRound: item.dealerEvent.gameRound,
                iTime: item.dealerEvent.iTime,
                roundStartTime: item.dealerEvent.roundStartTime,
                shuffle: item.dealerEvent.shuffle,
                statusGame: currentGame.status,
                // countDownFormat: currentGame.countDownFormat,
                // countDownUnix: currentGame.countDownUnix,
            },
            roadInfo: {
                repaintTime: item.roadInfo.repaintTime,
                winCounts: item.roadInfo.winCounts,
                prevGoodRoadJson: item.roadInfo.prevGoodRoadJson,
                currGoodRoadJson: item.roadInfo.currGoodRoadJson,
                bigRoads
            }
        };
    });
}

// init table
async function initDatabase(dataTableList) {
    try {
        let dataTableList_DB = []
        for (let i = 0; i < dataTableList.length; i++) {
            let tableDB = await predictResultSchema.findOne({ tableName: dataTableList[i].tableInfo.tableName })

            if (!tableDB) {
                try {
                    tableDB = await initTableNew(dataTableList[i])
                    dataTableList_DB.push(tableDB)
                } catch (err) {
                    if (err.code === 11000) {
                        tableDB = await predictResultSchema.findOne({
                            tableName: dataTableList[i].tableInfo.tableName,
                        })
                    } else {
                        throw err
                    }
                }
            }
        }

        return dataTableList_DB
    } catch (err) {
        await appendToLog(`Lỗi khi xử lý table : ${err}`, process.env.LOGS_SERVER_SEXY)
        return []
    }
}

async function initTableNew(table) {
    try {
        let totalRound = [];

        if (table.roadInfo.bigRoads.length > 0) {
            const sorted = [...table.roadInfo.bigRoads].sort(
                (a, b) => Number(b.stampTime) - Number(a.stampTime)
            );

            const total = sorted.length;

            totalRound = sorted.map((item, index) => ({
                ...item,
                win: true,
                roadFormat: checkWhoWinRound(item.road),
                roadRandom: checkWhoWinRound(item.road),
                id: total - index
            }));
        }
        let tableDB = new predictResultSchema({
            tableName: table.tableInfo.tableName,
            tableID: table.tableInfo.tableID,
            maintenance: table.tableInfo.maintenance,
            dealerImage: table.tableInfo.dealerImage,
            // eventType: table.dealerEvent.eventType,
            // gameRound: table.dealerEvent.gameRound,
            iTime: table.dealerEvent.iTime,
            roundStartTime: table.dealerEvent.roundStartTime,
            shuffle: table.dealerEvent.shuffle,
            statusGame: table.dealerEvent.statusGame,
            // countDownUnix: table.dealerEvent.counatDownUnix,
            percentCurrent: {
                Player: null,
                Tier: null,
                Banker: null,
                Round: null,
                Forecast: null,
            },
            winCounts: table.roadInfo?.winCounts ?? null,
            roundStats: resolveRoundStats(
                table.roadInfo?.bigRoads ?? [],
                table.roadInfo?.winCounts
            ),
            totalRound
        })
        await appendToLog(`Đã thêm table ${table.tableInfo.tableName} vào CSDL`, process.env.LOGS_SERVER_SEXY)
        await tableDB.save();
        return tableDB;
    } catch (error) {
        await appendToLog(`Error init new table ${error}`, process.env.LOGS_SERVER_SEXY)
    }
}

async function removeObsoleteRounds(tableName, bigRoads, totalRoundDB) {
    const newKeysSet = new Set(
        bigRoads.map(r => `${Number(r.stampTime)}:${Number(r.road)}`)
    );
    
    const newStampTimes = new Set(bigRoads.map(r => Number(r.stampTime)));
    
    const maxStampTime = bigRoads.length > 0 ? Math.max(...bigRoads.map(r => Number(r.stampTime))) : 0;

    const roundsToDelete = totalRoundDB.filter(r => {
        const key = `${Number(r.stampTime)}:${Number(r.road)}`;
        const existsInNew = newKeysSet.has(key);
        
        if (!existsInNew && newStampTimes.has(Number(r.stampTime))) {
            verboseLog(`[DEBUG removeObsoleteRounds] ${tableName} - GIỮ LẠI TIE OVERLAY:`, {
                stampTime: r.stampTime,
                road: r.road,
                roadFormat: r.roadFormat,
                reason: 'Cùng stampTime với round mới (TIE overlay)'
            });
            return false;
        }
        
        if (Number(r.stampTime) <= maxStampTime) {
            verboseLog(`[DEBUG removeObsoleteRounds] ${tableName} - GIỮ LẠI ROUND CŨ:`, {
                stampTime: r.stampTime,
                road: r.road,
                roadFormat: r.roadFormat,
                reason: `stampTime (${r.stampTime}) <= maxStampTime (${maxStampTime}) - giữ lại lịch sử`
            });
            return false;
        }
        
        return Number(r.stampTime) > maxStampTime;
    });

    if (roundsToDelete.length === 0) return;

    for (const round of roundsToDelete) {
        await predictResultSchema.updateOne(
            { tableName },
            { $pull: { totalRound: { stampTime: round.stampTime, road: round.road } } }
        );
    }

    await appendToLog(`❌ Đã xoá ${roundsToDelete.length} round cũ khỏi ${tableName}`, process.env.LOGS_SERVER_SEXY)
}

async function syncNewRounds(tableName, bigRoads, dbTable) {
    let totalRoundDB = sortByStampTimeDesc(dbTable.totalRound);
    const existingKeys = new Set(
        totalRoundDB.map(r => `${Number(r.stampTime)}:${Number(r.road)}`)
    );

    const newRoundsRaw = bigRoads.filter(
        r => !existingKeys.has(`${Number(r.stampTime)}:${Number(r.road)}`)
    );
    
    // Debug: Log để check TIE overlay
    if (newRoundsRaw.length > 0) {
        const newRoadFormats = newRoundsRaw.map(r => ({
            stampTime: r.stampTime,
            road: r.road,
            roadFormat: checkWhoWinRound(r.road)
        }));
        verboseLog(`[DEBUG syncNewRounds] ${tableName} - Thêm ${newRoundsRaw.length} round mới:`, newRoadFormats);
        
        // Check xem có TIE overlay không (cùng stampTime nhưng road khác)
        const newStampTimes = new Set(newRoundsRaw.map(r => Number(r.stampTime)));
        const existingWithSameStampTime = totalRoundDB.filter(r => newStampTimes.has(Number(r.stampTime)));
        if (existingWithSameStampTime.length > 0) {
            verboseLog(`[DEBUG syncNewRounds] ${tableName} - CÓ TIE OVERLAY! Các round cùng stampTime trong DB:`, 
                existingWithSameStampTime.map(r => ({ stampTime: r.stampTime, road: r.road, roadFormat: r.roadFormat }))
            );
        }
    }
    
    if (newRoundsRaw.length === 0) return [];

    // Tìm ID lớn nhất hiện có trong DB (nếu không có thì bắt đầu từ 0)
    const maxId = totalRoundDB.reduce((max, r) => Math.max(max, Number(r.id || 0)), 0);
    // Sắp xếp các round mới theo stampTime giảm dần (trong trường hợp server delay sẽ nạp nhiều trường vào db)
    const sortedRounds = [...newRoundsRaw].sort((a, b) => Number(b.stampTime) - Number(a.stampTime));

    // gán id tiếp nối từ maxId + 1 trở đi
    const newRounds = sortedRounds.map((r, index) => ({
        stampTime: r.stampTime,
        showX: r.showX,
        showY: r.showY,
        count: r.count,
        road: r.road,
        win: true,
        roadFormat: checkWhoWinRound(r.road),
        roadRandom: dbTable.percentCurrent.Round || null,
        id: maxId + (index + 1)
    }));

    totalRoundDB.unshift(newRounds)
    const calculate = calculateWinningPercentage(totalRoundDB)
    const roadPercent = buildRoadPercentCurrent(totalRoundDB.flat ? totalRoundDB.flat() : totalRoundDB)

    let percent = {
        ...roadPercent,
        Forecast: calculate || roadPercent.Forecast,
    }

    verboseLog(percent)
    await predictResultSchema.updateOne(
        { tableName },
        {
            $set: {
                percentCurrent: percent
            },
            $push: {
                totalRound: { $each: newRounds }
            }
        }
    );
// if(tableName == 'C15') console.log(`\n\n===================> ${sortedRounds[0].road} - ${tableName} `)
    
    await appendToLog(`✅ Đã thêm ${newRounds.length} round mới vào ${tableName}, bắt đầu từ id = ${maxId + 1}`, process.env.LOGS_SERVER_SEXY)
    return newRounds;
}

/** Giữ tối đa N round/bàn — tránh Mongo phình vô hạn trên VPS. */
async function trimExcessRounds(tableName) {
    const doc = await predictResultSchema
        .findOne({ tableName })
        .select('totalRound -_id');
    if (!doc || doc.totalRound.length <= MAX_TOTAL_ROUNDS_PER_TABLE) return;

    const keep = sortByStampTimeDesc(doc.totalRound).slice(0, MAX_TOTAL_ROUNDS_PER_TABLE);
    await predictResultSchema.updateOne({ tableName }, { $set: { totalRound: keep } });
    verboseLog(`[trimExcessRounds] ${tableName}: ${doc.totalRound.length} → ${keep.length}`);
}

// luôn cập nhật trạng thái bàn với nếu có thay đôi
async function syncRoundStatsFromApi(tableName, table) {
    const bigRoads = table.roadInfo?.bigRoads ?? [];
    const winCounts = table.roadInfo?.winCounts ?? null;
    const roundStats = resolveRoundStats(bigRoads, winCounts);
    await predictResultSchema.updateOne(
        { tableName },
        { $set: { winCounts, roundStats } }
    );
}

async function updateStatusTable(dbTable, table) {
    try {
        let statusTableNew = {
            maintenance: table.tableInfo.maintenance,
            roundStartTime: table.dealerEvent.roundStartTime,
            shuffle: table.dealerEvent.shuffle,
            statusGame: currentGameStatus(table).status,
        }
        let _dbTable = {
            maintenance: dbTable.maintenance,
            roundStartTime: dbTable.roundStartTime,
            shuffle: dbTable.shuffle,
            statusGame: dbTable.statusGame,
        }
        if (isEqual(statusTableNew, _dbTable)) return;

        await predictResultSchema.updateOne(
            { tableName: dbTable.tableName },
            { $set: statusTableNew }
        );

    } catch (err) {
        await appendToLog(`Lỗi khi cập nhật trạng thái table: ${dbTable.tableName}`, process.env.LOGS_SERVER_SEXY);
    }
}

async function checkAndUpdateDatabase(dataTableList, io = null) {
    try {
        const formattedList = dataTableList.map(item => ({
            tableName: item.tableInfo.tableName,
            table: item,
            bigRoads: item.roadInfo?.bigRoads ?? []
        }));

        for (const { tableName, bigRoads, table } of formattedList) {
            const dbTable = await predictResultSchema
                .findOne({ tableName })
                .select('tableName totalRound percentCurrent maintenance shuffle roundStartTime statusGame winCounts roundStats -_id');

            if (!dbTable) {
                await appendToLog(`❗ Không tìm thấy tableName ${tableName} trong DB`, process.env.LOGS_SERVER_SEXY)
                continue;
            }

            await updateStatusTable(dbTable, table)
            await syncRoundStatsFromApi(tableName, table);
            const addedRounds = await syncNewRounds(tableName, bigRoads, dbTable);
            if (addedRounds && addedRounds.length > 0 && io) {
                io.emit("new_round_completed", {
                    tableName,
                    newRoundsCount: addedRounds.length,
                    latestRound: addedRounds[0],
                    resultWinner: addedRounds[0]?.roadFormat, // 'B' (Cái), 'P' (Con), 'T' (Hòa)
                    stampTime: Date.now()
                });
                console.log(`[SOCKET EMIT] new_round_completed for table: ${tableName} (Winner: ${addedRounds[0]?.roadFormat})`);
            }
            
            const updatedDbTable = await predictResultSchema.findOne({ tableName }).select('totalRound -_id');
            await removeObsoleteRounds(tableName, bigRoads, updatedDbTable?.totalRound || dbTable.totalRound);
            await trimExcessRounds(tableName);
        }
    } catch (err) {
        await appendToLog(`Lỗi khi đồng bộ DB checkAndUpdateDatabase ${err} trong DB`, process.env.LOGS_SERVER_SEXY)
    }
}

module.exports = {
    filterData,
    initDatabase,
    checkAndUpdateDatabase,
};
