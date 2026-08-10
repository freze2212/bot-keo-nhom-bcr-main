const router = require('express').Router()

const predictResultControllers = require('../controllers/predictResult.controllers')

router.get('/get-table-by-name', predictResultControllers.verifyJWT, predictResultControllers.getOne)
router.get('/get-all-table', predictResultControllers.verifyJWT, predictResultControllers.getAll)

module.exports = router