timeSendSessionDelay = process.env.TIME_SEND_SESSION_SOCKET_DELAY || 3000

account_1 = {
    timeSendSessionDelay,
    username_game: process.env.USERNAME_ACCOUNT || 'bosdx22',
    password_game: process.env.PASSWORD_ACCOUNT || 'abc112233',
    nameServiceSocket: 'NS1',
    logsNameProgress: 'logs_progress_ns1',
    userDataDir: 'ns1',
    namePm2: 'session_sexy_1',
}

account_2 = {
    timeSendSessionDelay,
    username_game: 'rr88testbmin2',
    password_game: 'rr88testbmin11',
    nameServiceSocket: 'NS2',
    logsNameProgress: 'logs_progress_ns2',
    userDataDir: 'ns2',
    namePm2: 'session_sexy_2',
}

account_3 = {
    timeSendSessionDelay,
    username_game: 'rr88testbmin3',
    password_game: 'rr88testbmin11',
    nameServiceSocket: 'NS3',
    logsNameProgress: 'logs_progress_ns3',
    userDataDir: 'ns3',
    namePm2: 'session_sexy_3',
}

account_4 = {
    timeSendSessionDelay,
    username_game: 'rr88testbmin4',
    password_game: 'rr88testbmin11',
    nameServiceSocket: 'NS4',
    logsNameProgress: 'logs_progress_ns4',
    userDataDir: 'ns4',
    namePm2: 'session_sexy_4',
}

account_5 = {
    timeSendSessionDelay,
    username_game: 'rr88testbmin5',
    password_game: 'rr88testbmin11',
    nameServiceSocket: 'NS5',
    logsNameProgress: 'logs_progress_ns5',
    userDataDir: 'ns5',
    namePm2: 'session_sexy_5',
}

module.exports = {
    account_1,
    account_2,
    account_3,
    account_4,
    account_5,
}