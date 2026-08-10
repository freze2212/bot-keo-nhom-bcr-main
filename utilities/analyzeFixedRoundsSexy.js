function adjustPercent(B, P, T) {
    const tier = Math.max(2, Math.min(20, T));
    const remaining = 100 - tier;
    const totalBP = B + P || 1;

    const newB = Math.round((B / totalBP) * remaining);
    const newP = 100 - tier - newB;

    return { B: newB, P: newP, T: tier };
}

function calculator_1(rounds) {
    const groupSize = 3;
    const sortedRounds = [...rounds].sort((a, b) => a.stampTime - b.stampTime);

    const groupRoad = [];
    const dominantWinCount = { B: 0, P: 0, T: 0 };
    let totalWin = 0;

    for (let i = 0; i < sortedRounds.length; i += groupSize) {
        const group = sortedRounds.slice(i, i + groupSize);
        if (group.length < groupSize) break;

        const count = { B: 0, P: 0, T: 0 };
        let winInGroup = 0;

        group.forEach(item => {
            const key = item.roadFormat;
            count[key] = (count[key] || 0) + 1;
            if (item.win) winInGroup += 1;
        });

        const maxCount = Math.max(count.B, count.P, count.T);
        const dominantFormats = Object.keys(count).filter(k => count[k] === maxCount);

        const groupWin = maxCount >= 2 && dominantFormats.length === 1;
        const dominant = dominantFormats.length === 1 ? dominantFormats[0] : null;

        if (groupWin && dominant) {
            dominantWinCount[dominant] += 1;
        }

        totalWin += winInGroup;

        groupRoad.push({
            id: groupRoad.length + 1,
            groupWin,
            countWin: winInGroup,
            dominant
        });
    }

    const totalDominant = dominantWinCount.B + dominantWinCount.P + dominantWinCount.T || 1;
    const percentBanker = Math.round((dominantWinCount.B / totalDominant) * 100);
    const percentPlayer = Math.round((dominantWinCount.P / totalDominant) * 100);
    const percentTier = Math.round((dominantWinCount.T / totalDominant) * 100);

    const adjusted = adjustPercent(percentBanker, percentPlayer, percentTier);
    const percentMap = { B: adjusted.B, P: adjusted.P, T: adjusted.T };
    const sorted = Object.entries(percentMap).sort((a, b) => b[1] - a[1]);
    const [best] = sorted;
    const forecast = Math.max(66, Math.min(100, best[1] + 10 - (best[1] % 2)));

    return {
        groupRoad: {
            table: groupRoad,
            total: {
                group: groupRoad.length,
                loss: groupRoad.filter(g => !g.groupWin).length,
                win: totalWin
            }
        },
        percentCurrent: {
            Player: percentMap.P,
            Banker: percentMap.B,
            Tier: percentMap.T,
            Round: best[0],
            Forecast: forecast
        }
    };
}

function calculator_2(rounds) {
    const sorted = [...rounds].sort((a, b) => a.stampTime - b.stampTime);
    const groupRoad = [];
    const streaks = { B: 0, P: 0, T: 0 };
    let totalWin = 0;

    let current = null;
    let streakLength = 0;

    for (let i = 0; i < sorted.length; i++) {
        const fmt = sorted[i].roadFormat;
        if (fmt === current) {
            streakLength++;
        } else {
            if (current) streaks[current] = Math.max(streaks[current], streakLength);
            current = fmt;
            streakLength = 1;
        }

        if (sorted[i].win) totalWin++;
    }
    streaks[current] = Math.max(streaks[current], streakLength);

    const percentSum = streaks.B + streaks.P + streaks.T || 1;
    const percentBanker = Math.round((streaks.B / percentSum) * 100);
    const percentPlayer = Math.round((streaks.P / percentSum) * 100);
    const percentTier = Math.round((streaks.T / percentSum) * 100);

    const adjusted = adjustPercent(percentBanker, percentPlayer, percentTier);
    const percentMap = { B: adjusted.B, P: adjusted.P, T: adjusted.T };
    const sortedP = Object.entries(percentMap).sort((a, b) => b[1] - a[1]);
    const [best] = sortedP;
    const forecast = Math.max(66, Math.min(100, best[1] + 10 - (best[1] % 2)));

    for (let i = 0; i < sorted.length; i += 3) {
        const group = sorted.slice(i, i + 3);
        if (group.length < 3) break;
        const winCount = group.filter(x => x.win).length;
        groupRoad.push({
            id: groupRoad.length + 1,
            groupWin: winCount >= 2,
            countWin: winCount
        });
    }

    return {
        groupRoad: {
            table: groupRoad,
            total: {
                group: groupRoad.length,
                loss: groupRoad.filter(g => !g.groupWin).length,
                win: totalWin
            }
        },
        percentCurrent: {
            Player: percentMap.P,
            Banker: percentMap.B,
            Tier: percentMap.T,
            Round: best[0],
            Forecast: forecast
        }
    };
}
function calculator_3(rounds) {
    const sortedRounds = [...rounds].sort((a, b) => a.stampTime - b.stampTime);
    const formatWins = { B: 0, P: 0, T: 0 };
    const groupRoad = [];
    let totalWin = 0;

    for (let i = 0; i < sortedRounds.length; i += 3) {
        const group = sortedRounds.slice(i, i + 3);
        if (group.length < 3) break;

        let groupWin = 0;
        group.forEach(item => {
            if (item.win) {
                formatWins[item.roadFormat]++;
                groupWin++;
            }
        });

        groupRoad.push({
            id: groupRoad.length + 1,
            groupWin: groupWin >= 2,
            countWin: groupWin
        });

        totalWin += groupWin;
    }

    const totalDominant = formatWins.B + formatWins.P + formatWins.T || 1;
    const percentBanker = Math.round((formatWins.B / totalDominant) * 100);
    const percentPlayer = Math.round((formatWins.P / totalDominant) * 100);
    const percentTier = Math.round((formatWins.T / totalDominant) * 100);

    const adjusted = adjustPercent(percentBanker, percentPlayer, percentTier);
    const percentMap = { B: adjusted.B, P: adjusted.P, T: adjusted.T };
    const sorted = Object.entries(percentMap).sort((a, b) => b[1] - a[1]);
    const [best] = sorted;
    const forecast = Math.max(66, Math.min(100, best[1] + 10 - (best[1] % 2)));

    return {
        groupRoad: {
            table: groupRoad,
            total: {
                group: groupRoad.length,
                loss: groupRoad.filter(g => !g.groupWin).length,
                win: totalWin
            }
        },
        percentCurrent: {
            Player: percentMap.P,
            Banker: percentMap.B,
            Tier: percentMap.T,
            Round: best[0],
            Forecast: forecast
        }
    };
}

function calculator_4(rounds) {
    const sorted = [...rounds].sort((a, b) => a.stampTime - b.stampTime);
    const score = { B: 0, P: 0, T: 0 };
    const groupRoad = [];
    let totalWin = 0;

    const weight = { B: 3, P: 2, T: 1 };

    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].win) {
            const fmt = sorted[i].roadFormat;
            score[fmt] += weight[fmt];
            totalWin++;
        }
    }

    const totalScore = score.B + score.P + score.T || 1;
    const percentBanker = Math.round((score.B / totalScore) * 100);
    const percentPlayer = Math.round((score.P / totalScore) * 100);
    const percentTier = Math.round((score.T / totalScore) * 100);

    const adjusted = adjustPercent(percentBanker, percentPlayer, percentTier);
    const percentMap = { B: adjusted.B, P: adjusted.P, T: adjusted.T };
    const sortedP = Object.entries(percentMap).sort((a, b) => b[1] - a[1]);
    const [best] = sortedP;
    const forecast = Math.max(66, Math.min(100, best[1] + 10 - (best[1] % 2)));

    for (let i = 0; i < sorted.length; i += 3) {
        const group = sorted.slice(i, i + 3);
        if (group.length < 3) break;

        const winCount = group.filter(x => x.win).length;
        groupRoad.push({
            id: groupRoad.length + 1,
            groupWin: winCount >= 2,
            countWin: winCount
        });
    }

    return {
        groupRoad: {
            table: groupRoad,
            total: {
                group: groupRoad.length,
                loss: groupRoad.filter(g => !g.groupWin).length,
                win: totalWin
            }
        },
        percentCurrent: {
            Player: percentMap.P,
            Banker: percentMap.B,
            Tier: percentMap.T,
            Round: best[0],
            Forecast: forecast
        }
    };
}
function calculator_5(data) {
    const sortedData = [...data].sort((a, b) => a.stampTime - b.stampTime);

    const groups = [];
    for (let i = 0; i < sortedData.length; i += 3) {
        const group = sortedData.slice(i, i + 3);
        if (group.length === 3) groups.push(group);
    }

    let totalWin = 0;
    let totalLoss = 0;

    const processedGroups = groups.map(group => {
        const winCount = group.filter(item => item.win).length;
        const lossCount = 3 - winCount;
        totalWin += winCount;
        totalLoss += lossCount;

        return {
            id: groups.length + 1,
            win: winCount,
            loss: lossCount,
            result: winCount >= 2 ? 'win' : 'loss'
        };
    });

    const totalItems = sortedData.length;
    const countP = sortedData.filter(item => item.roadRandom === 'P').length;
    const countB = sortedData.filter(item => item.roadRandom === 'B').length;
    const countT = sortedData.filter(item => item.roadRandom === 'T').length;

    const percentP = Math.floor((countP / totalItems) * 100);
    const percentB = Math.floor((countB / totalItems) * 100);
    const percentT = Math.floor((countT / totalItems) * 100);

    const recent = sortedData.slice(-5);
    const winCount = recent.filter(item => item.win).length;
    let forecast = 65 + winCount * 5;
    const round = percentB >= percentP && percentB >= percentT ? 'B' : (percentP >= percentT ? 'P' : 'T');
    forecast += recent.filter(x => x.roadRandom === round).length * 2;
    forecast = Math.max(65, Math.min(100, Math.floor(forecast / 2) * 2));

    const adjusted = adjustPercent(percentB, percentP, percentT);

    return {
        groupRoad: {
            table: processedGroups,
            total: {
                group: groups.length,
                loss: totalLoss,
                win: totalWin
            }
        },
        percentCurrent: {
            Player: adjusted.P,
            Banker: adjusted.B,
            Tier: adjusted.T,
            Round: round,
            Forecast: forecast
        }
    };
}

module.exports = {
    calculator_1,
    calculator_2,
    calculator_3,
    calculator_4,
    calculator_5,
};