import { Alchemy, Network } from "alchemy-sdk";
import contractAddresses from "../../contractAddresses.json";
import { utils } from "ethers";

export async function setInitialState(chainId) {
  const addresses =
    chainId in contractAddresses
      ? contractAddresses[chainId]
      : contractAddresses["1"];

  var tradingPools = [];
  var lps = {};
  var maxHeaps = {};
  var minHeap = {};

  const alchemySettings = {
    apiKey: process.env.ALCHEMY_API_KEY,
    network: chainId == 1 ? Network.ETH_MAINNET : Network.ETH_GOERLI,
  };
  const alchemy = new Alchemy(alchemySettings);

  // Initial Setup
  const createTradingPoolTopic =
    "0xf2b8d398085ceadfce4f6fd552acf36e537609826798cb78bcde9fb1cc7cb913";
  const addLiquidityTopic =
    "0xf2b8d398085ceadfce4f6fd552acf36e537609826798cb78bcde9fb1cc7cb913";
  const removeLiquidityTopic =
    "0xf9e7f47c2cd7655661046fbcf0164a4d4ac48c3cd9c0ed8b45410e965cc33714";

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
  }

  // Get added liquidity
  const addLiquidityResponse = await alchemy.core.getLogs({
    address: addresses.Trading,
    fromBlock: "earliest",
    toBlock: "latest",
    topics: [addLiquidityTopic],
  });

  for (let i = 0; i < addLiquidityResponse.length; i++) {
    const result = addLiquidityResponse[i];

    const lpId = utils.defaultAbiCoder.decode(["uint256"], result.topics[2])[0];

    lps.push(lpId);
  }

  // Get removed liquidity
  const removedLiquidityResponse = await alchemy.core.getLogs({
    address: addresses.Market,
    fromBlock: "earliest",
    toBlock: "latest",
    topics: [removeLiquidityTopic],
  });

  for (let i = 0; i < removedLiquidityResponse.length; i++) {
    const result = addLiquidityResponse[i];

    const lpId = utils.defaultAbiCoder.decode(["uint256"], result.topics[2])[0];

    lps.push(lpId);
  }

  return lps;
}
