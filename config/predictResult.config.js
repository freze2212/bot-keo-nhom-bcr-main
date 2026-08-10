const CONFIG_RANDOM = {
    PROBABILITIES: {
        T: 0.01,  // 1%
        B: 0.495, // 49.5%
    },
    PERCENTAGE_RANGES: {
        P: {
            Player: { min: 52, max: 65 },
            Tier: { min: 1, max: 11 }
        },
        B: {
            Banker: { min: 52, max: 65 },
            Tier: { min: 1, max: 11 }
        },
        T: {
            Tier: { min: 51, max: 58 }
        }
    }
};

let SESSION_LIST = {
    session: {
        NS1: {
            nameService: undefined,
            sessionId: undefined,
            stampTime: -1,
            namePm2: 'session_sexy_1',
        },
        NS2: {
            nameService: undefined,
            sessionId: undefined,
            stampTime: -1,
            namePm2: 'session_sexy_2',
        },
        NS3: {
            nameService: undefined,
            sessionId: undefined,
            stampTime: -1,
            namePm2: 'session_sexy_3',
        },
        NS4: {
            nameService: undefined,
            sessionId: undefined,
            stampTime: -1
        }
    },
    sessionFailover: {
        nameService: undefined,
        sessionId: undefined,
        stampTime: -1
    }
}


module.exports = {
    CONFIG_RANDOM,
    SESSION_LIST,
}