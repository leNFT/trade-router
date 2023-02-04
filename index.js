import { setInitialState } from "./setInitialState.js";
import { Alchemy, Network } from "alchemy-sdk";
import { utils } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { Heap } from "heap-js";
import contractAddresses from "./contractAddresses.json" assert { type: "json" };
import express from "express";
import tradingPoolContract from "./contracts/TradingPool.json" assert { type: "json" };

import Cors from "cors";
import initMiddleware from "./lib/init-middleware.js";
const app = express();
const port = 8080;
const alchemySettings = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ETH_GOERLI,
};
const alchemy = new Alchemy(alchemySettings);
const maxPriceComparator = (a, b) => b.price - a.price;
const minPriceComparator = (a, b) => a.price - b.price;
// Set initial var state for chain id
var { tradingPools, maxHeaps, minHeaps } = await setInitialState(5);
const addresses = contractAddresses["5"];

// Initialize the cors middleware
const cors = initMiddleware(
  // You can read more about the available options here: https://github.com/expressjs/cors#configuration-options
  Cors({
    // Only allow requests with GET and from the frontend
    methods: ["GET"],
    origin: [
      "https://lenft.finance",
      "http://localhost:3000",
      "https://lenft.fi",
    ],
  })
);

// Set up subscriptions
createNewTradingPoolSubscription();
tradingPools.forEach((pool) => {
  poolTradingActivitySubscription(pool);
  poolLiquidityActivitySubscription(pool);
  poolUserActivitySubscription(pool);
});

// Setup swap router endpoint
app.get("/swap", async (req, res) => {
  // Run cors
  await cors(req, res);
  const sellAmount = req.query["sellAmount"];
  const buyAmount = req.query["buyAmount"];
  const sellPool = req.query["sellPool"];
  const buyPool = req.query["buyPool"];
  const priceAfterSellFunctionSig = "0x6d31f2ca";
  const priceAfterBuyFunctionSig = "0xbb1690e2";
  var buyPrice = 0;
  var sellPrice = 0;
  var selectedSellLps = [];
  var selectedBuyLps = [];
  var exampleBuyNFTs = [];
  var firstBuyPrice = 0;
  var lastBuyPrice = 0;
  var firstSellPrice = 0;
  var lastSellPrice = 0;

  if (sellAmount == 0 || buyAmount == 0) {
    res.status(400).send({
      error: "Sell or buy amount is 0",
    });
    return;
  }

  if (buyPool == sellPool) {
    res.status(400).send({
      error: "Buy and sell pool are the same",
    });
    return;
  }

  // Find each pool's swap fee
  const getSellPoolFeeResponse = await alchemy.core.call({
    to: sellPool,
    data: getSwapFeeFunctionSig,
  });
  const sellPoolFee = utils.defaultAbiCoder
    .decode(["uint256"], getSellPoolFeeResponse)[0]
    .toNumber();
  const getBuyPoolFeeResponse = await alchemy.core.call({
    to: buyPool,
    data: getSwapFeeFunctionSig,
  });
  const buyPoolFee = utils.defaultAbiCoder
    .decode(["uint256"], getBuyPoolFeeResponse)[0]
    .toNumber();

  // Find the most expensive pool to sell into
  if (maxHeaps[sellPool]) {
    var maxHeap = maxHeaps[sellPool].clone();

    // Get the price of the sell amount
    while (selectedSellLps.length < sellAmount) {
      // if the lp with the lowest price has enough liquidity we add it to the response
      const maxLp = maxHeap.pop();
      if (maxLp === undefined) {
        break;
      }
      if (BigNumber.from(maxLp.tokenAmount).gte(maxLp.price)) {
        console.log("maxLp", maxLp);
        // Save the first sell price
        if (selectedSellLps.length == 0) {
          firstSellPrice = maxLp.price;
        }
        // Add lp to selectedSellLps
        selectedSellLps.push(maxLp.id);
        // Add lp price to sell price sum
        sellPrice = BigNumber.from(maxLp.price).add(sellPrice).toString();

        // Add lp with update buy price to min lp
        // Get buy price and add it to the heap
        const getPriceAfterSellResponse = await alchemy.core.call({
          to: maxLp.curve,
          data:
            priceAfterSellFunctionSig +
            utils.defaultAbiCoder
              .encode(["uint256"], [maxLp.basePrice])
              .slice(2) +
            utils.defaultAbiCoder
              .encode(["uint256"], [BigNumber.from(maxLp.delta).toString()])
              .slice(2),
        });

        const nextSellPrice = utils.defaultAbiCoder
          .decode(["uint256"], getPriceAfterSellResponse)[0]
          .toString();
        console.log("nextSellPrice", nextSellPrice);
        maxHeap.push({
          id: maxLp.id,
          basePrice: nextSellPrice,
          price: (nextSellPrice * (10000 - maxLp.fee)) / 10000,
          curve: maxLp.curve,
          delta: BigNumber.from(maxLp.delta).toString(),
          tokenAmount: BigNumber.from(maxLp.tokenAmount)
            .sub(maxLp.price)
            .toString(),
          nfts: maxLp.nfts,
          fee: maxLp.fee,
        });
      }
    }

    // Save the last sell price
    if (!maxHeap.isEmpty()) {
      lastSellPrice = maxHeap.peek().price;
    }
  }

  // Find the cheapest pool to buy from
  if (minHeaps[buyPool]) {
    var minHeap = minHeaps[buyPool].clone();

    while (selectedBuyLps.length < buyAmount) {
      // if the lp with the lowest price has enough liquidity we add it to the response
      var minLp = minHeap.pop();
      if (minLp === undefined) {
        break;
      }
      if (minLp.nfts.length > 0) {
        // Save the first buy price
        if (selectedBuyLps.length == 0) {
          firstBuyPrice = minLp.price;
        }
        // Add lp to selectedBuyLps
        selectedBuyLps.push(minLp.id);
        // Add lp price to buy price sum
        buyPrice = BigNumber.from(minLp.price).add(buyPrice).toString();
        // Add LP's nft to exampleBuyNFTs
        exampleBuyNFTs.push(
          BigNumber.from(minLp.nfts[minLp.nfts.length - 1]).toNumber()
        );

        // Add lp with update buy price to min lp
        // Get buy price and add it to the heap
        const getPriceAfterBuyResponse = await alchemy.core.call({
          to: minLp.curve,
          data:
            priceAfterBuyFunctionSig +
            utils.defaultAbiCoder
              .encode(["uint256"], [minLp.basePrice])
              .slice(2) +
            utils.defaultAbiCoder
              .encode(["uint256"], [BigNumber.from(minLp.delta).toString()])
              .slice(2),
        });

        const nextBuyPrice = utils.defaultAbiCoder
          .decode(["uint256"], getPriceAfterBuyResponse)[0]
          .toString();
        console.log("nextBuyPrice", nextBuyPrice);
        minHeap.push({
          id: minLp.id,
          basePrice: nextBuyPrice,
          price: (nextBuyPrice * (10000 + minLp.fee)) / 10000,
          curve: minLp.curve,
          delta: BigNumber.from(minLp.delta).toString(),
          tokenAmount: BigNumber.from(minLp.tokenAmount).toString(),
          nfts: minLp.nfts.slice(0, -1),
          fee: minLp.fee,
        });
      }
    }

    // Save the last buy price
    if (!minHeap.isEmpty()) {
      lastBuyPrice = minHeap.peek().price;
    }
  }

  res.send({
    sellLps: selectedSellLps,
    sellPrice: sellPrice,
    sellPriceImpact: firstSellPrice
      ? Math.floor(
          BigNumber.from(firstSellPrice)
            .sub(lastSellPrice)
            .mul(10000)
            .div(firstSellPrice)
            .toNumber()
        )
      : 0,
    buyLps: selectedBuyLps,
    buyPrice: buyPrice,
    buyPriceImpact: firstBuyPrice
      ? Math.floor(
          BigNumber.from(lastBuyPrice)
            .sub(firstBuyPrice)
            .mul(10000)
            .div(firstBuyPrice)
            .toNumber()
        )
      : 0,
    exampleBuyNFTs: exampleBuyNFTs,
  });
});

// Setup swap router endpoint
app.get("/swapExact", async (req, res) => {
  // Run cors
  await cors(req, res);
  const sellAmount = req.query["sellAmount"];
  const buyNFTs = req.query["buyNFTs"].split(",");
  const sellPool = req.query["sellPool"];
  const buyPool = req.query["buyPool"];
  const priceAfterSellFunctionSig = "0x6d31f2ca";
  const priceAfterBuyFunctionSig = "0xbb1690e2";
  const getLpFunctionSig = "0xcdd3f298";
  const nftToLpFunctionSig = "0x5460d849";
  var buyPrice = 0;
  var sellPrice = 0;
  var selectedSellLps = [];
  var selectedBuyLps = [];
  var selectedLpBuyPrice = {};

  if (sellAmount == 0 || buyNFTs.length == 0) {
    res.status(400).send({
      error: "Sell or buy amount is 0",
    });
    return;
  }

  if (buyPool == sellPool) {
    res.status(400).send({
      error: "Buy and sell pool are the same",
    });
    return;
  }

  // Find the most expensive pool to sell into
  if (maxHeaps[sellPool]) {
    var maxHeap = maxHeaps[sellPool].clone();

    // Get the price of the sell amount
    while (selectedSellLps.length < sellAmount) {
      // if the lp with the lowest price has enough liquidity we add it to the response
      const maxLp = maxHeap.pop();
      if (maxLp === undefined) {
        break;
      }
      if (BigNumber.from(maxLp.tokenAmount).gte(maxLp.price)) {
        console.log("maxLp", maxLp);
        selectedSellLps.push(maxLp.id);
        sellPrice = BigNumber.from(maxLp.price).add(sellPrice).toString();

        // Add lp with update buy price to min lp
        // Get buy price and add it to the heap
        const getPriceAfterSellResponse = await alchemy.core.call({
          to: maxLp.curve,
          data:
            priceAfterSellFunctionSig +
            utils.defaultAbiCoder
              .encode(["uint256"], [maxLp.basePrice])
              .slice(2) +
            utils.defaultAbiCoder
              .encode(["uint256"], [BigNumber.from(maxLp.delta).toString()])
              .slice(2),
        });

        const nextSellPrice = utils.defaultAbiCoder
          .decode(["uint256"], getPriceAfterSellResponse)[0]
          .toString();
        console.log("nextSellPrice", nextSellPrice);
        maxHeap.push({
          id: maxLp.id,
          curve: maxLp.curve,
          delta: BigNumber.from(maxLp.delta).toString(),
          basePrice: nextSellPrice,
          price: (nextSellPrice * (10000 - maxLp.fee)) / 10000,
          tokenAmount: BigNumber.from(maxLp.tokenAmount)
            .sub(maxLp.price)
            .toString(),
          nfts: maxLp.nfts,
          fee: maxLp.fee,
        });
      }
    }
  }

  // Find the price for the selected buy NFTs
  for (var i = 0; i < buyNFTs.length; i++) {
    // Get the LP for the token
    var basePrice = 0;
    const getLPIDResponse = await alchemy.core.call({
      to: buyPool,
      data:
        nftToLpFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [buyNFTs[i]]).slice(2),
    });

    const lpId = utils.defaultAbiCoder
      .decode(["uint256"], getLPIDResponse)[0]
      .toNumber();
    selectedBuyLps.push(lpId);

    // Get the LP
    const getNewLpResponse = await alchemy.core.call({
      to: buyPool,
      data:
        getLpFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [lpId]).slice(2),
    });

    const iface = new utils.Interface(tradingPoolContract.abi);
    const lp = iface.decodeFunctionResult("getLP", getNewLpResponse);
    console.log("lp", lp);
    if (selectedLpBuyPrice[lpId] === undefined) {
      basePrice = lp[0].price;
    } else {
      basePrice = selectedLpBuyPrice[lpId];
    }

    // Add lp with update buy price to min lp
    // Get buy price and add it to the heap
    const getPriceAfterBuyResponse = await alchemy.core.call({
      to: lp[0].curve,
      data:
        priceAfterBuyFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [basePrice]).slice(2) +
        utils.defaultAbiCoder
          .encode(["uint256"], [BigNumber.from(lp[0].delta).toString()])
          .slice(2),
    });
    const nextBuyPrice = utils.defaultAbiCoder
      .decode(["uint256"], getPriceAfterBuyResponse)[0]
      .toString();
    console.log("nextBuyPrice", nextBuyPrice);
    buyPrice =
      buyPrice +
      (nextBuyPrice * (10000 + BigNumber.from(lp[0].fee).toString())) / 10000;

    selectedLpBuyPrice[lpId] = nextBuyPrice;
  }

  res.send({
    sellLps: selectedSellLps,
    sellPrice: sellPrice,
    buyLps: selectedBuyLps,
    buyPrice: buyPrice,
  });
});

// Setup buy router endpoint
app.get("/buy", async (req, res) => {
  // Run cors
  await cors(req, res);
  const buyAmount = req.query["amount"];
  const pool = req.query["pool"];
  const priceAfterBuyFunctionSig = "0xbb1690e2";
  var selectedLps = [];
  var exampleNFTs = [];
  var priceSum = 0;
  var firstPrice = 0;
  var lastPrice = 0;

  // Clone the heap so we can change it freely
  if (minHeaps[pool]) {
    var minHeap = minHeaps[pool].clone();

    while (selectedLps.length < buyAmount) {
      // if the lp with the lowest price has enough liquidity we add it to the response
      var minLp = minHeap.pop();
      if (minLp === undefined) {
        break;
      }
      if (minLp.nfts.length > 0) {
        // Save the first sell price
        if (selectedLps.length == 0) {
          firstPrice = minLp.price;
        }

        selectedLps.push(minLp.id);
        priceSum = BigNumber.from(minLp.price).add(price).toString();
        exampleNFTs.push(
          BigNumber.from(minLp.nfts[minLp.nfts.length - 1]).toNumber()
        );

        // Add lp with update buy price to min lp
        // Get buy price and add it to the heap
        const getPriceAfterBuyResponse = await alchemy.core.call({
          to: minLp.curve,
          data:
            priceAfterBuyFunctionSig +
            utils.defaultAbiCoder
              .encode(["uint256"], [minLp.basePrice])
              .slice(2) +
            utils.defaultAbiCoder
              .encode(["uint256"], [BigNumber.from(minLp.delta).toString()])
              .slice(2),
        });

        const nextBuyPrice = utils.defaultAbiCoder
          .decode(["uint256"], getPriceAfterBuyResponse)[0]
          .toString();
        console.log("nextBuyPrice", nextBuyPrice);
        minHeap.push({
          id: minLp.id,
          basePrice: nextBuyPrice,
          price:
            (nextBuyPrice * (10000 + BigNumber.from(minLp.fee).toNumber())) /
            10000,
          curve: minLp.curve,
          delta: BigNumber.from(minLp.delta).toString(),
          tokenAmount: BigNumber.from(minLp.tokenAmount).toString(),
          nfts: minLp.nfts.slice(0, -1),
          fee: minLp.fee,
        });
      }
    }

    // Save the last sell price
    if (!minHeap.isEmpty()) {
      lastPrice = minHeap.peek().price;
    }
  }

  res.send({
    lps: selectedLps,
    price: priceSum,
    priceImpact: firstPrice
      ? Math.floor(
          BigNumber.from(lastPrice)
            .sub(firstPrice)
            .mul(10000)
            .div(firstPrice)
            .toNumber()
        )
      : 0,
    exampleNFTs: exampleNFTs,
  });
});

// Setup buy router endpoint
app.get("/buyExact", async (req, res) => {
  // Run cors
  await cors(req, res);
  const nfts = req.query["nfts"].split(",");
  const pool = req.query["pool"];
  const priceAfterBuyFunctionSig = "0xbb1690e2";
  const nftToLpFunctionSig = "0x5460d849";
  const getLpFunctionSig = "0xcdd3f298";
  var selectedLps = [];
  var selectedLpBuyPrice = {};
  var priceSum = "0";

  console.log("nfts", nfts);

  for (var i = 0; i < nfts.length; i++) {
    // Get the LP for the token
    var basePrice = 0;
    const getLPIDResponse = await alchemy.core.call({
      to: pool,
      data:
        nftToLpFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [nfts[i]]).slice(2),
    });

    const lpId = utils.defaultAbiCoder
      .decode(["uint256"], getLPIDResponse)[0]
      .toNumber();
    selectedLps.push(lpId);

    // Get the LP
    const getNewLpResponse = await alchemy.core.call({
      to: pool,
      data:
        getLpFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [lpId]).slice(2),
    });

    const iface = new utils.Interface(tradingPoolContract.abi);
    const lp = iface.decodeFunctionResult("getLP", getNewLpResponse);
    console.log("lp", lp);
    if (selectedLpBuyPrice[lpId] === undefined) {
      basePrice = lp[0].price;
    } else {
      basePrice = selectedLpBuyPrice[lpId];
    }

    // Add lp with update buy price to min lp
    // Get buy price and add it to the heap
    const getPriceAfterBuyResponse = await alchemy.core.call({
      to: lp[0].curve,
      data:
        priceAfterBuyFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [basePrice]).slice(2) +
        utils.defaultAbiCoder
          .encode(["uint256"], [BigNumber.from(lp[0].delta).toString()])
          .slice(2),
    });

    const nextBuyPrice = utils.defaultAbiCoder
      .decode(["uint256"], getPriceAfterBuyResponse)[0]
      .toString();
    console.log("nextBuyPrice", nextBuyPrice);
    priceSum = BigNumber.from(priceSum)
      .add(
        (nextBuyPrice * (10000 + BigNumber.from(lp[0].fee).toNumber())) / 10000
      )
      .toString();
    selectedLpBuyPrice[lpId] = nextBuyPrice;
  }

  res.send({
    lps: selectedLps,
    price: priceSum,
  });
});

// Setup sell router endpoint
app.get("/sell", async (req, res) => {
  // Run cors
  await cors(req, res);
  const sellAmount = req.query["amount"];
  const priceAfterSellFunctionSig = "0x6d31f2ca";
  const getSwapFeeFunctionSig = "0xd4cadf68";
  const pool = req.query["pool"];
  var selectedLps = [];
  var price = 0;
  var firstPrice = 0;
  var lastPrice = 0;

  // Clone the heap so we can change it freely
  if (maxHeaps[pool]) {
    var maxHeap = maxHeaps[pool].clone();

    while (selectedLps.length < sellAmount) {
      // if the lp with the lowest price has enough liquidity we add it to the response
      const maxLp = maxHeap.pop();
      if (maxLp === undefined) {
        break;
      }
      if (BigNumber.from(maxLp.tokenAmount).gte(maxLp.price)) {
        // Store the first price
        if (selectedLps.length === 0) {
          firstPrice = maxLp.price;
        }
        console.log("maxLp", maxLp);
        selectedLps.push(maxLp.id);
        price = BigNumber.from(maxLp.price).add(price).toString();

        // Add lp with update buy price to min lp
        // Get buy price and add it to the heap
        const getPriceAfterSellResponse = await alchemy.core.call({
          to: maxLp.curve,
          data:
            priceAfterSellFunctionSig +
            utils.defaultAbiCoder.encode(["uint256"], [maxLp.price]).slice(2) +
            utils.defaultAbiCoder
              .encode(["uint256"], [BigNumber.from(maxLp.delta).toString()])
              .slice(2),
        });

        const nextSellPrice = utils.defaultAbiCoder
          .decode(["uint256"], getPriceAfterSellResponse)[0]
          .toString();
        console.log("nextSellPriddce", nextSellPrice);
        maxHeap.push({
          id: maxLp.id,
          basePrice: nextSellPrice,
          price: (nextSellPrice * (10000 - maxLp.fee).toString()) / 10000,
          curve: maxLp.curve,
          delta: BigNumber.from(maxLp.delta).toString(),
          tokenAmount: BigNumber.from(maxLp.tokenAmount)
            .sub(maxLp.price)
            .toString(),
          nfts: maxLp.nfts,
          fee: maxLp.fee,
        });
      }
    }

    // Store the last price
    if (!maxHeap.isEmpty()) {
      lastPrice = maxHeap.peek().price;
    }
  }

  res.send({
    lps: selectedLps,
    price: price,
    priceImpact: firstPrice
      ? Math.floor(
          BigNumber.from(firstPrice)
            .sub(lastPrice)
            .mul(10000)
            .div(firstPrice)
            .toNumber()
        )
      : 0,
  });
});

function createNewTradingPoolSubscription() {
  // Create a websocket to listen for new pools
  const newTradingPoolsFilter = {
    address: addresses.TradingPoolFactory,
    topics: [utils.id("CreateTradingPool(address,address,address)")],
  };

  alchemy.ws.on(newTradingPoolsFilter, (log, event) => {
    // Emitted whenever a new trading pool is created
    const tradingPool = utils.defaultAbiCoder.decode(
      ["address"],
      log.topics[1]
    )[0];

    tradingPools.push(tradingPool);
    maxHeaps[tradingPool] = new Heap(maxPriceComparator);
    minHeaps[tradingPool] = new Heap(minPriceComparator);

    // Subscribe to the new trading pool activites
    poolTradingActivitySubscription(tradingPool);
    poolLiquidityActivitySubscription(tradingPool);

    console.log("Got new trading pool: ", tradingPool);
  });

  console.log("Set up new trading pools filter");
}

function poolLiquidityActivitySubscription(pool) {
  console.log("Creating liquidity activity subscription for ", pool);

  const addLiquidityTopic =
    "0x3b67bb924a0e01cd52df231e47e53b28799a0f34d0ea653d1778cf3969492c1e";
  const removeLiquidityTopic =
    "0xdfdd120ded9b7afc0c23dd5310e93aaa3e1c3b9f75af9b805fab3030842439f2";

  // Create a websocket to listen to a pools activity
  const addLiquidityPoolActivityFilter = {
    address: pool,
    topics: [addLiquidityTopic],
  };
  const removeLiquidityPoolActivityFilter = {
    address: pool,
    topics: [removeLiquidityTopic],
  };

  alchemy.ws.on(addLiquidityPoolActivityFilter, async (log, event) => {
    const priceAfterBuyFunctionSig = "0xbb1690e2";
    const getLpFunctionSig = "0xcdd3f298";
    const lpId = utils.defaultAbiCoder
      .decode(["uint256"], log.topics[2])[0]
      .toNumber();

    // If a user is doing a buying operation
    console.log("Got new add liquidity, lpId:", lpId);
    console.log("pool:", pool);
    const getNewLpResponse = await alchemy.core.call({
      to: pool,
      data:
        getLpFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [lpId]).slice(2),
    });

    const iface = new utils.Interface(tradingPoolContract.abi);
    const lp = iface.decodeFunctionResult("getLP", getNewLpResponse);
    console.log("lp", lp);

    // Get current (sell) price and add it to the max heap
    const currentPrice = BigNumber.from(lp[0].price).toString();
    console.log("currentPrice", currentPrice);
    maxHeaps[pool].push({
      id: lpId,
      basePrice: currentPrice,
      price:
        (currentPrice * (10000 - BigNumber.from(lp[0].fee).toString())) / 10000,
      curve: lp[0].curve,
      delta: BigNumber.from(lp[0].delta).toString(),
      tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
      nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
      fee: BigNumber.from(lp[0].fee).toString(),
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
      .toString();
    console.log("buyPrice", buyPrice);
    minHeaps[pool].push({
      id: lpId,
      basePrice: buyPrice,
      price:
        (buyPrice * (10000 + BigNumber.from(lp[0].fee).toString())) / 10000,
      curve: lp[0].curve,
      delta: BigNumber.from(lp[0].delta).toString(),
      tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
      nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
      fee: BigNumber.from(lp[0].fee).toString(),
    });

    console.log("addedliquidity. maxHeaps:", maxHeaps[pool].heapArray);
  });

  alchemy.ws.on(removeLiquidityPoolActivityFilter, async (log, event) => {
    const lpId = utils.defaultAbiCoder
      .decode(["uint256"], log.topics[2])[0]
      .toNumber();

    // If a user is doing a selling operation
    console.log("Got new remove liquidity");

    // Find LPs in heaps' liquidity positions
    const nftMaxHeapLpIndex = maxHeaps[pool].heapArray.findIndex(
      (el) => el.id == lpId
    );
    const nftMinHeapLpIndex = minHeaps[pool].heapArray.findIndex(
      (el) => el.id == lpId
    );
    maxHeaps[pool].remove(maxHeaps[pool].heapArray[nftMaxHeapLpIndex]);
    minHeaps[pool].remove(minHeaps[pool].heapArray[nftMinHeapLpIndex]);
  });
}

function poolTradingActivitySubscription(pool) {
  console.log("Creating trading activity subscription for ", pool);

  // Update LP from logs
  async function updateLPWithLog(log, mode) {
    const getLpFunctionSig = "0xcdd3f298";
    const nftToLpFunctionSig = "0x5460d849";
    const priceAfterBuyFunctionSig = "0xbb1690e2";
    console.log("log", log);
    // Emitted whenever a new buy / sell is done in a pool
    const iface = new utils.Interface(tradingPoolContract.abi);
    const decodedLog = iface.parseLog({ data: log.data, topics: log.topics });
    console.log("decodedLog", decodedLog);
    var nfts = decodedLog.args.nftIds;
    console.log("NFTs: ", nfts);

    // Find all the LPs we need to update
    var updatedLps = [];
    for (let index = 0; index < nfts.length; index++) {
      var nftLP;
      const nft = BigNumber.from(nfts[index]).toNumber();
      console.log("nft", nft);
      if (mode == "buy") {
        const nftMaxHeapNFTIndex = maxHeaps[pool].heapArray.findIndex(
          (el) => el.nfts.includes(nft) == true
        );
        console.log("nftMaxHeapNFTIndex", nftMaxHeapNFTIndex);
        console.log("maxHeaps[pool].heapArray", maxHeaps[pool].heapArray);
        nftLP = maxHeaps[pool].heapArray[nftMaxHeapNFTIndex].id;
      } else if (mode == "sell") {
        // Get the lp where the nfts went to
        const nftToLpResponse = await alchemy.core.call({
          to: pool,
          data:
            nftToLpFunctionSig +
            utils.defaultAbiCoder.encode(["uint256"], [nft]).slice(2),
        });
        nftLP = iface
          .decodeFunctionResult("nftToLp", nftToLpResponse)[0]
          .toNumber();
      }
      console.log("nftLP", nftLP);
      if (!updatedLps.includes(nftLP)) {
        console.log("add LP's NFT to the LP list: ", nftLP);
        updatedLps.push(nftLP);
      }
    }

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
      maxHeaps[pool].remove(maxHeaps[pool].heapArray[nftMaxHeapLpIndex]);
      minHeaps[pool].remove(minHeaps[pool].heapArray[nftMinHeapLpIndex]);

      const getNewLpResponse = await alchemy.core.call({
        to: pool,
        data:
          getLpFunctionSig +
          utils.defaultAbiCoder.encode(["uint256"], [lpId]).slice(2),
      });

      const lp = iface.decodeFunctionResult("getLP", getNewLpResponse);
      console.log("lp", lp);

      // Get current (sell) price and add it to the max heap
      const currentPrice = BigNumber.from(lp[0].price).toString();
      console.log("currentPrice", currentPrice);
      maxHeaps[pool].push({
        id: lpId,
        basePrice: currentPrice,
        price:
          (currentPrice * (10000 - BigNumber.from(lp[0].fee).toString())) /
          10000,
        curve: lp[0].curve,
        delta: BigNumber.from(lp[0].delta).toString(),
        tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
        nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
        fee: BigNumber.from(lp[0].fee).toString(),
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
        .toString();
      console.log("buyPrice", buyPrice);
      minHeaps[pool].push({
        id: lpId,
        basePrice: buyPrice,
        price:
          (buyPrice * (10000 + BigNumber.from(lp[0].fee).toString())) / 10000,
        curve: lp[0].curve,
        delta: BigNumber.from(lp[0].delta).toString(),
        tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
        nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
        fee: BigNumber.from(lp[0].fee).toString(),
      });
    }
  }

  // Create two websocket to listen to a pools activity (buy and sell)
  const buyPoolActivityFilter = {
    address: pool,
    topics: [utils.id("Buy(address,uint256[],uint256)")],
  };

  const sellPoolActivityFilter = {
    address: pool,
    topics: [utils.id("Sell(address,uint256[],uint256)")],
  };

  alchemy.ws.on(sellPoolActivityFilter, async (log, event) => {
    console.log("Got new selling swap");
    await updateLPWithLog(log, "sell");
  });

  alchemy.ws.on(buyPoolActivityFilter, async (log, event) => {
    console.log("Got new buying swap");
    await updateLPWithLog(log, "buy");
  });
}

function poolUserActivitySubscription(pool) {
  console.log("Creating trading activity subscription for ", pool);

  // Update LP from logs
  async function updateLPWithLog(log) {
    const getLpFunctionSig = "0xcdd3f298";
    const priceAfterBuyFunctionSig = "0xbb1690e2";
    // Emitted whenever a new user activity is done in a pool
    const iface = new utils.Interface(tradingPoolContract.abi);
    const decodedLog = iface.parseLog({ data: log.data, topics: log.topics });
    console.log("decodedLog", decodedLog);
    const lpId = decodedLog.args.lpId;
    console.log("lpId: ", lpId);

    // Find LP in heaps' liquidity positions
    const nftMaxHeapLpIndex = maxHeaps[pool].heapArray.findIndex(
      (el) => el.id == lpId
    );
    const nftMinHeapLpIndex = minHeaps[pool].heapArray.findIndex(
      (el) => el.id == lpId
    );

    // Remove LP from heaps
    maxHeaps[pool].remove(maxHeaps[pool].heapArray[nftMaxHeapLpIndex]);
    minHeaps[pool].remove(minHeaps[pool].heapArray[nftMinHeapLpIndex]);

    const getNewLpResponse = await alchemy.core.call({
      to: pool,
      data:
        getLpFunctionSig +
        utils.defaultAbiCoder.encode(["uint256"], [lpId]).slice(2),
    });

    const lp = iface.decodeFunctionResult("getLP", getNewLpResponse);
    console.log("lp", lp);

    // Get current (sell) price and add it to the max heap
    const currentPrice = BigNumber.from(lp[0].price).toString();
    console.log("currentPrice", currentPrice);
    maxHeaps[pool].push({
      id: lpId,
      basePrice: currentPrice,
      price:
        (currentPrice * (10000 - BigNumber.from(lp[0].fee).toString())) / 10000,
      curve: lp[0].curve,
      delta: BigNumber.from(lp[0].delta).toString(),
      tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
      nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
      fee: BigNumber.from(lp[0].fee).toString(),
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
      .toString();
    console.log("buyPrice", buyPrice);
    minHeaps[pool].push({
      id: lpId,
      basePrice: buyPrice,
      price:
        (buyPrice * (10000 + BigNumber.from(lp[0].fee).toString())) / 10000,
      curve: lp[0].curve,
      delta: BigNumber.from(lp[0].delta).toString(),
      tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
      nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
      fee: BigNumber.from(lp[0].fee).toString(),
    });
  }

  // Create two websocket to listen to a pools activity (buy and sell)
  const setLpPricingCurveActivityFilter = {
    address: pool,
    topics: [utils.id("SetLpPricingCurve(address,uint256,address,uint256)")],
  };

  const setLpPriceActivityFilter = {
    address: pool,
    topics: [utils.id("SetLpPrice(address,uint256,uint256)")],
  };

  const setLpFeeActivityFilter = {
    address: pool,
    topics: [utils.id("SetLpFee(address,uint256,uint256)")],
  };

  alchemy.ws.on(setLpPricingCurveActivityFilter, async (log, event) => {
    console.log("Got new lp edit pricing curve activity");
    await updateLPWithLog(log);
  });

  alchemy.ws.on(setLpPriceActivityFilter, async (log, event) => {
    console.log("Got new lp edit price activity");
    await updateLPWithLog(log);
  });

  alchemy.ws.on(setLpFeeActivityFilter, async (log, event) => {
    console.log("Got new lp edit fee activity");
    await updateLPWithLog(log);
  });
}

// Listen to new connections
app.listen(port, () => {
  console.log(`leNFT Trade Router listening on port ${port}`);
});
