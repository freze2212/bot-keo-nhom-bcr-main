const predictResult = require("./predictResult.routers");
const gameNH = require("./gameNH.routers");

function router(app) {
  app.use("/predict", predictResult);
  app.use("/NH", gameNH);
}

module.exports = router;
