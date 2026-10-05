import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { encodeFunctionData, toFunctionSelector, zeroAddress, zeroHash } from "viem";
import { factoryAbi, freshSalt, minOut, tokenParams, validateConfig } from "../lib.mjs";

const shipped = JSON.parse(readFileSync(new URL("../lane.config.json", import.meta.url), "utf8"));

test("the shipped config is valid and launches $LANE against native ETH", () => {
  const { config, warnings } = validateConfig(shipped);
  assert.equal(config.symbol, "LANE");
  assert.equal(config.pairToken, zeroAddress);
  assert.equal(config.devBuyWei, 0n);
  assert.match(warnings.join(), /logo is empty/);
});

test("every problem is reported at once", () => {
  assert.throws(
    () =>
      validateConfig({
        name: "",
        symbol: "X".repeat(17),
        socials: { tiktok: "x" },
        pairToken: "nope",
        creatorTaxBps: -1,
        devBuyEth: "abc",
        salt: "0x12",
      }),
    (err) => {
      for (const part of ["name is required", "symbol is longer", "socials.tiktok", "pairToken", "creatorTaxBps", "devBuyEth", "salt"]) {
        assert.match(err.message, new RegExp(part.replace(".", "\\.")));
      }
      return true;
    },
  );
});

test("a dev buy is refused for ERC-20 quoted launches", () => {
  assert.throws(
    () => validateConfig({ ...shipped, pairToken: "0x1111111111111111111111111111111111111111", devBuyEth: "0.1" }),
    /only supported for native-ETH/,
  );
});

test("launchToken selectors match the Solidity signatures in PonsV2LaunchFactory", () => {
  const tuple =
    "(string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32)";
  const selectors = factoryAbi.filter((x) => x.type === "function" && x.name === "launchToken").map(toFunctionSelector);
  assert.deepEqual(selectors.sort(), [
    toFunctionSelector(`launchToken(${tuple},uint256,address)`),
    toFunctionSelector(`launchToken(${tuple},uint256,address,address[])`),
  ].sort());
});

test("tokenParams encodes as launchToken calldata", () => {
  const { config } = validateConfig({ ...shipped, logo: "ipfs://logo" });
  const salt = freshSalt("0x00000000000000000000000000000000000000AA", "LANE", 1);
  const data = encodeFunctionData({ abi: factoryAbi, functionName: "launchToken", args: [tokenParams(config, zeroHash, salt), 0n, zeroAddress] });
  assert.ok(data.startsWith("0x") && data.length > 10);
  assert.notEqual(salt, freshSalt("0x00000000000000000000000000000000000000AA", "LANE", 2));
});

test("minOut applies slippage in basis points", () => {
  assert.equal(minOut(10_000n, 300), 9_700n);
  assert.equal(minOut(10_000n, 0), 10_000n);
});
