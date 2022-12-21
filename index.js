import { setInitialState } from "./setInitialState.js";
import express from "express";
const app = express();
const port = 8080;
var { lps, maxHeap, minHeap } = await setInitialState(5);

app.get("/", (req, res) => {
  res.send("SwapRouter Service");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
