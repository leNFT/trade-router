import { setInitialState } from "./setInitialState.js";
import { Alchemy, Network } from "alchemy-sdk";
import { utils } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { Heap } from "heap-js";
import contractAddresses from "./contractAddresses.json" assert { type: "json" };
import express from "express";
const app = express();
const port = 8080;
const alchemySettings = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ETH_GOERLI,
};
const alchemy = new Alchemy(alchemySettings);
const maxPriceComparator = (a, b) => a.price - b.price;
const minPriceComparator = (a, b) => b.price - a.price;
// Set initial var state for chain id 5
var { tradingPools, maxHeaps, minHeaps } = await setInitialState(5);
const addresses = contractAddresses["5"];

// Set up subscriptions
createNewTradingPoolSubscription();
tradingPools.forEach((pool) => {
  tradingPoolActivitySubscription(pool);
});

// Setup buy router endpoint
app.get("/buy", async (req, res) => {
  const buyAmount = req.query["amount"];
  const pool = req.query["pool"];
  const priceAfterBuyFunctionSig = "0xbb1690e2";
  var selectedLps = [];

  // Clone the heap so we can change it freely
  var minHeap = minHeaps[pool].clone();

  while (selectedLps.length < buyAmount) {
    // if the lp with the lowest price has enough liquidity we add it to the response
    const minLp = minHeap.pop();
    if (minLp === undefined) {
      break;
    }
    if (minLp.nfts.length > 0) {
      selectedLps.push(minLp.id);

      // Add lp with update buy price to min lp
      // Get buy price and add it to the heap
      const getPriceAfterBuyResponse = await alchemy.core.call({
        to: minLp.curve,
        data:
          priceAfterBuyFunctionSig +
          utils.defaultAbiCoder.encode(["uint256"], [minLp.price]).slice(2) +
          utils.defaultAbiCoder
            .encode(["uint256"], [BigNumber.from(minLp.delta).toString()])
            .slice(2),
      });

      const nextBuyPrice = utils.defaultAbiCoder
        .decode(["uint256"], getPriceAfterBuyResponse)[0]
        .toNumber();
      console.log("nextBuyPrice", nextBuyPrice);
      minHeaps[pool].push({
        id: minLp.id,
        price: nextBuyPrice,
        curve: minLp.curve,
        delta: BigNumber.from(minLp.delta).toNumber(),
        tokenAmount: BigNumber.from(minLp.tokenAmount).toString(),
        nfts: minLp.nfts.slice(0, -1),
      });
    }
  }
  res.send(selectedLps);
});

// Setup sell router endpoint
app.get("/sell", (req, res) => {
  res.send("SwapRouter Sell Service");
});

// Listen to new connections
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

function createNewTradingPoolSubscription() {
  // Create a websocket to listen for new pools
  const newTradingPoolsFilter = {
    address: addresses.TradingPoolFactory,
    topics: [utils.id("CreateTradingPool(address,address,address)")],
  };

  alchemy.ws.on(newTradingPoolsFilter, (log, event) => {
    // Emitted whenever a new trading pool is created
    console.log("log", log);

    const tradingPool = utils.defaultAbiCoder.decode(
      ["address"],
      log.topics[1]
    )[0];

    tradingPools.push(tradingPool);
    maxHeaps[tradingPool] = new Heap(maxPriceComparator);
    minHeaps[tradingPool] = new Heap(minPriceComparator);

    console.log("Got new trading pool: ", tradingPool);
  });

  console.log("Set up new trading pools filter");
}

async function tradingPoolActivitySubscription(pool) {
  const getLpFunctionSig = "0xcdd3f298";

  // Create a websocket to listen to a pools activity
  const tradingPoolActivityFilter = {
    address: pool,
    topics: [
      utils.id("Buy(address,uint256[],uint256)"),
      utils.id("Sell(address,uint256[],uint256)"),
    ],
  };

  alchemy.ws.on(tradingPoolActivityFilter, async (log, event) => {
    // Emitted whenever a new buy / sell is done in a pool
    console.log("Got pool activity ", pool);
    var nfts = utils.defaultAbiCoder.decode(["uint256[]"], log.topics[2])[0];
    console.log("NFTs: ", nfts);
    if (log.topics[0] == utils.id("Buy(address,uint256[],uint256)")) {
      // If a user is doing a buying operation
      console.log("Got new buying swap");
    } else if (log.topics[0] == utils.id("Sell(address,uint256[],uint256)")) {
      // If a user is doing a selling operation
      console.log("Got new selling swap");
    }

    // Find all the LPs we need to update
    var updatedLps = [];
    nfts.forEach((nft) => {
      const nftMaxHeapLpIndex = maxHeaps[pool].heapArray.findIndex(
        (el) => el.nfts.contains(nft) == true
      );
      const nftLP = maxHeaps[pool].heapArray[nftMaxHeapLpIndex].id;
      if (!updatedLps.contains(nftLP)) {
        console.log("add pool from NFT id: ", nftLP);
        updatedLps.push(nftLP);
      }
    });

    // Update every changed LP
    for (let index = 0; index < updatedLps.length; index++) {
      const lpId = updatedLps[index];

      // Find LPs in heaps' liquidity positions
      const nftMaxHeapLpIndex = maxHeaps[pool].heapArray.findIndex(
        (el) => el.id == lpId
      );
      const nftMinHeapLpIndex = minHeaps[pool].heapArray.findIndex(
        (el) => el.id == lpId
      );
      maxHeaps.remove(maxHeaps[pool].heapArray[nftMaxHeapLpIndex]);
      minHeaps.remove(minHeaps[pool].heapArray[nftMinHeapLpIndex]);

      const getNewLpResponse = await alchemy.core.call({
        to: pool,
        data:
          getLpFunctionSig +
          utils.defaultAbiCoder.encode(["uint256"], [lpId]).slice(2),
      });

      const lp = iface.decodeFunctionResult("getLP", getNewLpResponse);
      console.log("lp", lp);

      // Get current (sell) price and add it to the max heap
      const currentPrice = BigNumber.from(lp[0].price).toNumber();
      console.log("currentPrice", currentPrice);
      maxHeaps[pool].push({
        id: lpId,
        price: currentPrice,
        curve: lp[0].curve,
        delta: BigNumber.from(lp[0].delta).toNumber(),
        tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
        nfts: lp[0].nftIds,
      });

      // Get buy price and add it to the heap
      const getPriceAfterBuyResponse = await alchemy.core.call({
        to: lp[0].curve,
        data:
          priceAfterBuyFunctionSig +
          utils.defaultAbiCoder.encode(["uint256"], [currentPrice]).slice(2) +
          utils.defaultAbiCoder
            .encode(["uint256"], [BigNumber.from(lp[0].delta).toString()])
            .slice(2),
      });

      const buyPrice = utils.defaultAbiCoder
        .decode(["uint256"], getPriceAfterBuyResponse)[0]
        .toNumber();
      console.log("buyPrice", buyPrice);
      minHeaps[pool].push({
        id: lpId,
        price: buyPrice,
        curve: lp[0].curve,
        delta: BigNumber.from(lp[0].delta).toNumber(),
        tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
        nfts: lp[0].nftIds,
      });
    }
  });
}
