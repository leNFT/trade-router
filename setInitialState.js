import { Alchemy, Network } from "alchemy-sdk";
import contractAddresses from "./contractAddresses.json" assert { type: "json" };
import { BigNumber } from "@ethersproject/bignumber";
import { utils } from "ethers";
import tradingPoolContract from "./contracts/TradingPool.json" assert { type: "json" };
import { Heap } from "heap-js";
import dotenv from "dotenv";
dotenv.config();

export async function setInitialState(chainId) {
  const addresses =
    chainId in contractAddresses
      ? contractAddresses[chainId]
      : contractAddresses["1"];

  var tradingPools = [];
  var lps = {};
  var maxHeaps = {};
  var minHeaps = {};
  const maxPriceComparator = (a, b) => b.price - a.price;
  const minPriceComparator = (a, b) => a.price - b.price;

  const alchemySettings = {
    apiKey: process.env.ALCHEMY_API_KEY,
    network: chainId == 1 ? Network.ETH_MAINNET : Network.ETH_GOERLI,
  };
  const alchemy = new Alchemy(alchemySettings);

  // Initial Setup
  const priceAfterBuyFunctionSig = "0xbb1690e2";
  const getLpFunctionSig = "0xcdd3f298";

  // Get all the pools addresses
  const createTradingPoolResponse = await alchemy.core.getLogs({
    address: addresses.TradingPoolFactory,
    fromBlock: "earliest",
    toBlock: "latest",
    topics: [utils.id("CreateTradingPool(address,address,address)")],
  });

  for (let i = 0; i < createTradingPoolResponse.length; i++) {
    const result = createTradingPoolResponse[i];

    const tradingPool = utils.defaultAbiCoder.decode(
      ["address"],
      result.topics[1]
    )[0];

    tradingPools.push(tradingPool);
    maxHeaps[tradingPool] = new Heap(maxPriceComparator);
    minHeaps[tradingPool] = new Heap(minPriceComparator);
  }

  console.log("tradingPools", tradingPools);

  //Get info about LPs of each pool
  for (let i = 0; i < tradingPools.length; i++) {
    const tradingPool = tradingPools[i];
    lps[tradingPool] = [];

    // Get added liquidity
    const addLiquidityResponse = await alchemy.core.getLogs({
      address: tradingPool,
      fromBlock: "earliest",
      toBlock: "latest",
      topics: [
        utils.id(
          "AddLiquidity(address,uint256,uint256[],uint256,uint256,address,uint256,uint256)"
        ),
      ],
    });

    for (let i = 0; i < addLiquidityResponse.length; i++) {
      const result = addLiquidityResponse[i];
      const lpId = utils.defaultAbiCoder.decode(
        ["uint256"],
        result.topics[2]
      )[0];

      console.log("added lp: ", BigNumber.from(lpId).toNumber());

      lps[tradingPool].push(BigNumber.from(lpId).toNumber());
    }

    // Get removed liquidity
    const removedLiquidityResponse = await alchemy.core.getLogs({
      address: tradingPool,
      fromBlock: "earliest",
      toBlock: "latest",
      topics: [utils.id("RemoveLiquidity(address,uint256)")],
    });

    for (let i = 0; i < removedLiquidityResponse.length; i++) {
      const result = removedLiquidityResponse[i];

      const lpId = utils.defaultAbiCoder.decode(
        ["uint256"],
        result.topics[2]
      )[0];

      console.log("removed lp: ", BigNumber.from(lpId).toNumber());

      lps[tradingPool].splice(
        lps[tradingPool].indexOf(BigNumber.from(lpId).toNumber()),
        1
      );
    }
  }

  // Get liquidity positions for each pool to build heaps
  const iface = new utils.Interface(tradingPoolContract.abi);
  for (let i = 0; i < tradingPools.length; i++) {
    const tradingPool = tradingPools[i];
    console.log("Trading pool " + tradingPool + " LPs:", lps[tradingPool]);
    for (let u = 0; u < lps[tradingPool].length; u++) {
      const lpId = lps[tradingPool][u];

      const getLpResponse = await alchemy.core.call({
        to: tradingPool,
        data:
          getLpFunctionSig +
          utils.defaultAbiCoder.encode(["uint256"], [lpId]).slice(2),
      });

      const lp = iface.decodeFunctionResult("getLP", getLpResponse);
      console.log("lp", lp);

      // Get current (sell) price and add it to the max heap
      const currentPrice = BigNumber.from(lp[0].price).toString();
      console.log("currentPrice", currentPrice);
      maxHeaps[tradingPool].push({
        id: lpId,
        tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
        nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
        basePrice: currentPrice,
        price: BigNumber.from(currentPrice)
          .mul(10000 - BigNumber.from(lp[0].fee).toNumber())
          .div(10000)
          .toString(),

        curve: lp[0].curve,
        delta: BigNumber.from(lp[0].delta).toString(),
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
      minHeaps[tradingPool].push({
        id: lpId,
        tokenAmount: BigNumber.from(lp[0].tokenAmount).toString(),
        nfts: lp[0].nftIds.map((x) => BigNumber.from(x).toNumber()),
        basePrice: buyPrice,
        price: BigNumber.from(buyPrice)
          .mul(10000 + BigNumber.from(lp[0].fee).toNumber())
          .div(10000)
          .toString(),
        curve: lp[0].curve,
        delta: BigNumber.from(lp[0].delta).toString(),
        fee: BigNumber.from(lp[0].fee).toString(),
      });
    }
  }

  console.log("lps", lps);

  return { tradingPools, maxHeaps, minHeaps };
}
