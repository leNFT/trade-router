import { Alchemy, Network } from "alchemy-sdk";
import contractAddresses from "./contractAddresses.json" assert { type: "json" };
import { BigNumber } from "@ethersproject/bignumber";
import { utils } from "ethers";
import tradingPoolABI from "./contracts/TradingPool.json" assert { type: "json" };
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
  const maxPriceComparator = (a, b) => a.price - b.price;
  const minPriceComparator = (a, b) => b.price - a.price;

  const alchemySettings = {
    apiKey: process.env.ALCHEMY_API_KEY,
    network: chainId == 1 ? Network.ETH_MAINNET : Network.ETH_GOERLI,
  };
  const alchemy = new Alchemy(alchemySettings);

  // Initial Setup
  const createTradingPoolTopic =
    "0xa1311e5e3c1c2207844ec9211cb2439ea0bce2a76c6ea09d9343f0d0eaddd9f6";
  const addLiquidityTopic =
    "0x3b67bb924a0e01cd52df231e47e53b28799a0f34d0ea653d1778cf3969492c1e";
  const removeLiquidityTopic =
    "0xf9e7f47c2cd7655661046fbcf0164a4d4ac48c3cd9c0ed8b45410e965cc33714";
  const priceAfterBuyFunctionSig = "0xbb1690e2";

  // Get all the pools addresses
  const createTradingPoolResponse = await alchemy.core.getLogs({
    address: addresses.TradingPoolFactory,
    fromBlock: "earliest",
    toBlock: "latest",
    topics: [createTradingPoolTopic],
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
  console.log("maxHeaps", maxHeaps);

  //Get info about LPs of each pool
  for (let i = 0; i < tradingPools.length; i++) {
    const tradingPool = tradingPools[i];
    lps[tradingPool] = [];

    // Get added liquidity
    const addLiquidityResponse = await alchemy.core.getLogs({
      address: tradingPool,
      fromBlock: "earliest",
      toBlock: "latest",
      topics: [addLiquidityTopic],
    });

    for (let i = 0; i < addLiquidityResponse.length; i++) {
      const result = addLiquidityResponse[i];
      const lpId = utils.defaultAbiCoder.decode(
        ["uint256"],
        result.topics[2]
      )[0];

      lps[tradingPool].push(BigNumber.from(lpId).toNumber());
    }

    // Get removed liquidity
    const removedLiquidityResponse = await alchemy.core.getLogs({
      address: tradingPool,
      fromBlock: "earliest",
      toBlock: "latest",
      topics: [removeLiquidityTopic],
    });

    for (let i = 0; i < removedLiquidityResponse.length; i++) {
      const result = addLiquidityResponse[i];

      const lpId = utils.defaultAbiCoder.decode(
        ["uint256"],
        result.topics[2]
      )[0];

      lps[tradingPool].splice(
        lps[tradingPool].indexOf(BigNumber.from(lpId).toNumber()),
        1
      );
    }
  }

  // Get liquidity positions for each pool to build heaps
  const iface = new utils.Interface(tradingPoolABI);
  for (let i = 0; i < tradingPools.length; i++) {
    const tradingPool = tradingPools[i];
    for (let u = 0; u < lps[tradingPool].length; u++) {
      const lpId = lps[u];

      const getLpResponse = await alchemy.core.call({
        to: pool,
        data:
          getLpFunctionSig +
          ethers.utils.defaultAbiCoder.encode(["uint256"], lpId).slice(2),
      });

      console.log("getLpResponse", getLpResponse);
      const lp = iface.decodeFunctionResult("getLP", getLpResponse);

      // Get sell price and add it to the max heap
      const sellPrice = lp.price;
      maxHeaps.push({ id: lpId, price: sellPrice });

      // Get buy price and add it to the heap
      const getPriceAfterBuyResponse = await alchemy.core.call({
        to: lp.curve,
        data:
          priceAfterBuyFunctionSig +
          ethers.utils.defaultAbiCoder
            .encode(["uint256"], [lp.price])
            .slice(2) +
          ethers.utils.defaultAbiCoder
            .encode(["uint256"], [lp[0].delta.toString()])
            .slice(2),
      });
      const buyPrice = ethers.utils.defaultAbiCoder
        .decode(["uint256"], getPriceAfterBuyResponse)
        .toString();
      minHeaps.push({ id: lpId, price: buyPrice });
    }
  }

  console.log("lps", lps);
  console.log("minHeaps", minHeaps);
  console.log("maxHeaps", maxHeaps);

  return { maxHeaps, minHeaps };
}
