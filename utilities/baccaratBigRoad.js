/**
 * Đếm P/Hòa/B khớp bảng cầu lớn — cùng logic FE BigRoadBoard.
 * Dùng trên bigRoads[] từ API gốc (trước khi lưu totalRound).
 */

function detectRoundOutcome(item) {
    if (typeof item?.count === 'number' && item.count > 0) return 'T';
    if (item?.isTie === true || item?.tie === true) return 'T';
    if (item?.banker === true || item?.isBankerWin === true) return 'B';
    if (item?.player === true || item?.isPlayerWin === true) return 'P';

    if (typeof item?.road === 'number') {
        if ([0, 1, 2].includes(item.road)) return 'B';
        if ([8, 9, 10].includes(item.road)) return 'P';
        return 'T';
    }

    const v =
        item?.type ??
        item?.result ??
        item?.winner ??
        item?.value ??
        item?.outcome ??
        item?.roundResult;
    if (typeof v === 'string') {
        const s = v.toUpperCase();
        if (s === 'B' || s.includes('BANKER')) return 'B';
        if (s === 'P' || s.includes('PLAYER')) return 'P';
        if (s === 'T' || s.includes('TIE')) return 'T';
    }
    return null;
}

function formatBaccaratResults(results) {
    const rows = 6;
    const formatted = [];
    const occupied = new Set();
    const lastYByCol = new Map();
    const colIndexByShowX = new Map();
    let nextColIndex = 0;
    let lastType = null;
    let lastShowXRaw = null;
    let lastColIndex = null;

    let edgeLockActive = false;
    let edgePreferredRow = null;
    let edgeStartCol = null;
    let edgeStartFilled = false;

    for (let i = 0; i < results.length; i++) {
        const current = results[i];
        const outcome = detectRoundOutcome(current);

        if (outcome === 'T' || (typeof current?.count === 'number' && current.count > 0)) {
            if (formatted.length > 0) {
                const lastIndex = formatted.length - 1;
                const last = formatted[lastIndex];
                const baseType = String(last.type).replace('-H', '');
                const newType = baseType === 'B' ? 'B-H' : 'P-H';
                const newTieCount = (typeof last.tieCount === 'number' ? last.tieCount : 0) + 1;
                formatted[lastIndex] = {
                    ...last,
                    type: newType,
                    isTie: true,
                    tieCount: newTieCount,
                };
            }
            continue;
        }

        const rawX =
            typeof current?.showX === 'number' ? current.showX : (lastShowXRaw ?? 0);
        const lastCell = formatted.length > 0 ? formatted[formatted.length - 1] : null;
        const lastBaseType = lastCell
            ? String(lastCell.type).replace('-H', '')
            : null;
        const tieLockActive = !!(
            lastCell &&
            lastCell.isTie &&
            (lastCell.tieCount ?? 0) >= 2 &&
            lastBaseType
        );
        const continuingStreak =
            (outcome === 'B' || outcome === 'P') &&
            lastType !== null &&
            outcome === lastType &&
            lastColIndex !== null;

        let colIndex;
        if (tieLockActive && outcome === lastBaseType) {
            colIndex = lastColIndex ?? 0;
        } else if (tieLockActive && lastBaseType && outcome !== lastBaseType && lastColIndex !== null) {
            colIndex = nextColIndex++;
            colIndexByShowX.set(rawX, colIndex);
        } else if (continuingStreak) {
            colIndex = lastColIndex;
        } else if (colIndexByShowX.has(rawX)) {
            colIndex = colIndexByShowX.get(rawX);
        } else {
            colIndex = nextColIndex++;
            colIndexByShowX.set(rawX, colIndex);
        }

        let inferred;
        if (outcome === 'B' || outcome === 'P') {
            inferred = outcome;
        } else if (lastType == null) {
            inferred = 'B';
        } else {
            inferred =
                lastColIndex !== null && colIndex !== lastColIndex
                    ? lastType === 'B'
                        ? 'P'
                        : 'B'
                    : lastType;
        }

        const rowOccupied = (c, r) => occupied.has(`${c},${r}`);

        if (lastType !== null && inferred !== lastType) {
            let pref = null;
            if (rowOccupied(colIndex, rows - 1)) pref = rows - 2;
            else if (rowOccupied(colIndex, rows - 2)) pref = rows - 3;
            else if (rowOccupied(colIndex, rows - 3)) pref = rows - 4;
            else if (rowOccupied(colIndex, rows - 4)) pref = rows - 5;
            else if (rowOccupied(colIndex, rows - 5)) pref = rows - 6;

            if (pref !== null) {
                edgeLockActive = true;
                edgePreferredRow = pref;
                edgeStartCol = colIndex;
                edgeStartFilled = false;
            } else {
                edgeLockActive = false;
                edgePreferredRow = null;
                edgeStartCol = null;
                edgeStartFilled = false;
            }
        }

        let x = colIndex;
        let y;
        if (edgeLockActive && edgePreferredRow !== null) {
            const cleanDEF =
                !rowOccupied(colIndex, rows - 1) &&
                !rowOccupied(colIndex, rows - 2) &&
                !rowOccupied(colIndex, rows - 3);
            if (cleanDEF && edgeStartCol !== null && colIndex > edgeStartCol) {
                edgeLockActive = false;
            }
        }

        if (edgeLockActive && edgePreferredRow !== null) {
            if (edgeStartCol === colIndex && !edgeStartFilled) {
                const prevY = lastYByCol.get(colIndex) ?? -1;
                y = Math.min(prevY + 1, edgePreferredRow);
                if (y >= edgePreferredRow) edgeStartFilled = true;
                while (occupied.has(`${x},${y}`)) x += 1;
            } else {
                let target = edgePreferredRow;
                while (target >= 0 && rowOccupied(colIndex, target)) target -= 1;
                if (target < 0) target = 0;
                y = target;
                while (occupied.has(`${x},${y}`)) x += 1;
            }
        } else {
            const prevY = lastYByCol.get(colIndex) ?? -1;
            y = prevY + 1;
            if (y >= rows) y = rows - 1;
            while (occupied.has(`${x},${y}`)) x += 1;
        }

        formatted.push({
            x,
            y,
            tieCount: 0,
            type: inferred,
            isTie: false,
            colIndex,
        });
        occupied.add(`${x},${y}`);
        lastYByCol.set(colIndex, Math.min(y, rows - 1));
        lastType = inferred;
        lastShowXRaw = rawX;
        lastColIndex = colIndex;
    }

    return formatted;
}

/** Đếm từ bigRoads API — mỗi ô B/P + tieCount trên ô H */
function countPlayerTieBankerFromBigRoads(bigRoads) {
    if (!Array.isArray(bigRoads) || bigRoads.length === 0) {
        return { player: 0, tie: 0, banker: 0 };
    }

    const formatted = formatBaccaratResults(bigRoads);
    let player = 0;
    let tie = 0;
    let banker = 0;

    for (const cell of formatted) {
        const base = String(cell.type).replace('-H', '');
        if (base === 'P') player += 1;
        else if (base === 'B') banker += 1;
        tie += typeof cell.tieCount === 'number' ? cell.tieCount : 0;
    }

    return { player, tie, banker };
}

/** Chuẩn hoá winCounts từ API Sexy (nhiều kiểu key) */
function normalizeWinCounts(winCounts) {
    if (!winCounts || typeof winCounts !== 'object' || Array.isArray(winCounts)) {
        return null;
    }

    const pick = (...keys) => {
        for (const k of keys) {
            const v = winCounts[k];
            if (typeof v === 'number' && !Number.isNaN(v)) return Math.max(0, Math.floor(v));
        }
        return null;
    };

    const banker = pick('banker', 'Banker', 'B', 'b', 'bankerWin', 'bankerCount');
    const player = pick('player', 'Player', 'P', 'p', 'playerWin', 'playerCount');
    const tie = pick('tie', 'Tier', 'T', 't', 'Tie', 'tieCount');

    if (banker == null && player == null && tie == null) return null;

    return {
        player: player ?? 0,
        tie: tie ?? 0,
        banker: banker ?? 0,
    };
}

/**
 * Ưu tiên winCounts API gốc; không có/không parse được thì đếm từ bigRoads.
 */
function resolveRoundStats(bigRoads, winCountsFromApi) {
    const fromApi = normalizeWinCounts(winCountsFromApi);
    const fromRoads = countPlayerTieBankerFromBigRoads(bigRoads);

    if (fromApi && fromApi.banker + fromApi.player + fromApi.tie > 0) {
        return { ...fromApi, source: 'api' };
    }

    return { ...fromRoads, source: 'computed' };
}

module.exports = {
    detectRoundOutcome,
    formatBaccaratResults,
    countPlayerTieBankerFromBigRoads,
    normalizeWinCounts,
    resolveRoundStats,
};
