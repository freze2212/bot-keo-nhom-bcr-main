const { DateTime } = require('luxon');
const fs = require('fs').promises;
const path = require('path');

const { CONFIG_RANDOM } = require('../config/predictResult.config');

function getCurrentTime(fomat = "yyyy-MM-dd HH:mm:ss") {
    return {
        timeFormatted: DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat(fomat),
        timeUnix: DateTime.now().setZone('Asia/Ho_Chi_Minh').toMillis()
    }
}

function formatUnixTime(unixTimestamp, format = "HH:mm") {
    const dateTime = DateTime.fromMillis(unixTimestamp).setZone('Asia/Ho_Chi_Minh');
    
    if (!dateTime.isValid) {
        console.error(`Invalid timestamp: ${unixTimestamp}`);
        return '--:--';
    }
    
    return dateTime.toFormat(format);
}

async function appendToLog(message, logsName) {
    const content = `${getCurrentTime().timeFormatted} ${message}`
    try {
        console.log(content);
        // await fs.appendFile(path.join(__dirname, `../logs/${logsName}.log`), `${content}\n`, { encoding: 'utf8' });
    } catch (err) {
        console.error('Lỗi khi lưu log: ', err);
    }
}

async function delay(time) {
    // console.info(`Delay ${time / 1000}s`);
    return new Promise(function (resolve) {
        const min = time * 0.8;
        const max = time * 1.2;
        time = Math.floor(Math.random() * (max - min + 1)) + min
        setTimeout(resolve, time);
    });
}

function isValidSession(session) {
    const currentTime = getCurrentTime().timeUnix;
    const maxTimeDiff = 10 * 1000;

    return (
        typeof session.nameService === 'string' &&
        session.nameService.trim() !== '' &&
        typeof session.sessionId === 'string' &&
        session.sessionId.trim() !== '' &&
        typeof session.stampTime === 'number' &&
        session.stampTime > 0 &&
        (currentTime - session.stampTime) < maxTimeDiff
    );
}


function sortByStampTimeDesc(data = []) {
    if (!Array.isArray(data)) return [];

    return [...data].sort((a, b) => Number(b.stampTime) - Number(a.stampTime));
}

function getRandomInRange(range) {
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

function getRandomPercentages() {
    const rand = Math.random();
    let roundNext;

    if (rand < CONFIG_RANDOM.PROBABILITIES.T) {
        roundNext = 'T';
    } else if (rand < CONFIG_RANDOM.PROBABILITIES.T + CONFIG_RANDOM.PROBABILITIES.B) {
        roundNext = 'B';
    } else {
        roundNext = 'P';
    }

    let Player, Tier, Banker;

    switch (roundNext) {
        case 'P':
            Player = getRandomInRange(CONFIG_RANDOM.PERCENTAGE_RANGES.P.Player);
            Tier = getRandomInRange(CONFIG_RANDOM.PERCENTAGE_RANGES.P.Tier);
            Banker = 100 - Player - Tier;
            break;

        case 'B':
            Banker = getRandomInRange(CONFIG_RANDOM.PERCENTAGE_RANGES.B.Banker);
            Tier = getRandomInRange(CONFIG_RANDOM.PERCENTAGE_RANGES.B.Tier);
            Player = 100 - Banker - Tier;
            break;

        case 'T':
            Tier = getRandomInRange(CONFIG_RANDOM.PERCENTAGE_RANGES.T.Tier);
            const remaining = 100 - Tier;
            Player = Math.floor(Math.random() * remaining);
            Banker = remaining - Player;
            break;
    }

    // không được âm
    Player = Math.max(0, Player);
    Tier = Math.max(0, Tier);
    Banker = Math.max(0, Banker);

    return {
        Player,
        Tier,
        Banker,
        Round: roundNext
    };
}

function checkWhoWinRound(number) {
    const B = new Set([0, 1, 2]);
    const P = new Set([8, 9, 10]);

    if (B.has(number)) return "B";
    if (P.has(number)) return "P";
    return "T";
}
// hoà 12,4,13 — còn lại T
// cái 0,1,2 — B

// công thức tính tay ba: nhóm các 3 obj lại thành các group
// trong đó 1 obj đoán đúng => thắng
// trong đó 3 obj đoán sai => thua
function calculateGroupThreeSeries(data) {
    if (!Array.isArray(data) || data.length < 3) {
        return {
            calculatorGroup: [],
            calculatorRound: 100
        };
    }

    const sorted = [...data].sort((a, b) => a.stampTime - b.stampTime);
    const evaluated = sorted.map(item => ({
        ...item,
        isWin: item.roadFormat === item.roadRandom
    }));

    const calculatorGroup = [];
    for (let i = 0, groupId = 1; i <= evaluated.length - 3; i += 3, groupId++) {
        const group = evaluated.slice(i, i + 3);
        const countWin = group.filter(item => item.isWin).length;
        calculatorGroup.push({
            id: groupId,
            groupWin: countWin > 0,
            countWin
        });
    }

    const totalRoundWin = evaluated.filter(item => item.isWin).length;
    const totalRoundAll = evaluated.length;
    // console.log('totalRoundWin ', totalRoundWin)
    // console.log('totalRoundAll ', totalRoundAll)
    const calculatorRound = Number(((totalRoundWin / totalRoundAll) * 100).toFixed(2));

    // cân bằng lại tỷ lệ thua, cho nó giảm đi
    const _adjustGroupWin = adjustGroupWin(calculatorGroup);
    return {
        calculatorGroup,
        adjustGroupWin: _adjustGroupWin,
        calculatorRound
    };
}

// giảm 80% tỷ lệ thua sang thắng sau đó gán dữ liệu countWin
function adjustGroupWin(data) {
    const result = [...data];
    const falseGroups = result.filter(item => item.groupWin === false);
    if (falseGroups.length > 1) {
        const keepCount = Math.ceil(falseGroups.length * 0.2);
        const sortedFalse = falseGroups.sort((a, b) => a.id - b.id);
        const keepFalseIds = sortedFalse.slice(0, keepCount).map(item => item.id);

        for (let item of result) {
            if (!item.groupWin && !keepFalseIds.includes(item.id)) {
                item.groupWin = true;
                item.countWin = (item.id * 31 + 7) % 2 + 1; // 1 or 2
            }
        }
    }

    const totalGroup = result.length;
    const totalLoss = result.filter(item => item.groupWin === false).length;
    const totalWin = result.reduce((sum, item) => sum + (item.countWin || 0), 0);

    return {
        table: result,
        total: {
            group: totalGroup,
            loss: totalLoss,
            win: totalWin
        }
    };
}

function calculateWinningPercentage(data) {
    if (!Array.isArray(data)) return { adjustedAccuracy: null }

    const sorted = [...data].sort((a, b) => a.stampTime - b.stampTime);
    const evaluated = sorted.map(item => ({
        ...item,
        isWin: item.roadFormat === item.roadRandom
    }));

    for (let i = 0; i <= evaluated.length - 3; i += 3) {
        const group = evaluated.slice(i, i + 3);
        const countWin = group.filter(g => g.isWin).length;

        if (countWin === 0) {
            group[0].isWin = true;
            group[1].isWin = true;
            group[2].isWin = false;
        } else {
            group.forEach(g => g.isWin = true);
        }
    }

    const totalWins = evaluated.filter(item => item.isWin).length;
    const totalRounds = evaluated.length;
    const adjustedAccuracy = Number(((totalWins / totalRounds) * 100).toFixed(2));

    return adjustedAccuracy;
}

function currentGameStatus(item) {
    const currentTime = getCurrentTime().timeUnix;
    const roundStartTime = Number(item.dealerEvent.roundStartTime);
    const diffInMilliseconds = currentTime - roundStartTime;
    const countDownUnix = diffInMilliseconds - ((item.dealerEvent.iTime * 1000) - 1000); // trừ 1s delay so với bàn

    const countTime = Math.floor(countDownUnix / 1000)
    let status = 'UNDEFINED';
    let countDownFormat = '0';

    if (countTime < 1) countDownFormat = String(countTime).replace("-", "")
    const validEvents = ['GP_ONE_CARD_DRAWN', 'GP_NEW_GAME_START', 'GP_CHANGE_STATE', 'GP_WINNER'];
    const eventType = item.dealerEvent.eventType;
    status = validEvents.includes(eventType) ? eventType : 'UNDEFINED'; // trường hợp không xác định

    return {
        status,
        countDownFormat,
        countDownUnix,
    }
    // khoảng cách giao nhau hết đếm ngược và mở bài khoảng 5s
    // thời gian => GP_NEW_GAME_START => GP_ONE_CARD_DRAWN
    // GP_NEW_GAME_START => Kết thúc đếm ngược
    // GP_ONE_CARD_DRAWN => Đang mở bài
    // GP_CHANGE_STATE => đang đổi bài
    // GP_WINNER => đã có kêt quả
}

module.exports = {
    calculateGroupThreeSeries,
    getCurrentTime,
    appendToLog,
    delay,
    isValidSession,
    getRandomPercentages,
    checkWhoWinRound,
    currentGameStatus,
    getRandomInRange,
    sortByStampTimeDesc,
    calculateWinningPercentage,
    formatUnixTime,
};