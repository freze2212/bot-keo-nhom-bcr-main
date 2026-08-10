const router = require('express').Router()
const explodeNHControllers = require('../controllers/explodeNH.controllers')
const predictResultControllers = require('../controllers/predictResult.controllers')

// router.get('/addGame', explodeNHControllers.insertGameNH_Dev.bind(explodeNHControllers))
router.get('/tableList', predictResultControllers.verifyJWT, explodeNHControllers.getListTableByGroup.bind(explodeNHControllers))
router.get('/gameOne', predictResultControllers.verifyJWT, explodeNHControllers.getTableById.bind(explodeNHControllers))

module.exports = router