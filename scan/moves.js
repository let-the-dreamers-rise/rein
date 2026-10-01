// What a call or a signature would actually move, for the guard.
//
// A token transfer says who gets paid. A swap through a router doesn't: the
// router pulls the agent's tokens and sends what they buy to a `recipient`
// buried in the arguments, and a signature (an x402 payment, a Permit) moves
// money without the agent sending anything at all. The guard reads all three
// here, so that a swap paying a stranger, or a Permit handing a stranger an
// allowance, is held to the same payees and hourly limits as a transfer.
//
// What it reads: Uniswap V2 and V3 routers (both SwapRouter and SwapRouter02,
// including multicall), EIP-3009 transfer authorizations (how x402 pays),
// EIP-2612 and DAI permits, and Permit2. A signature it can't read is blocked;
// a call to a contract it can't read is held to the targets and functions the
// agent already uses, which is all the history can say about it.
const { ethers } = require("ethers");

const MSG_SENDER = "0x0000000000000000000000000000000000000001"; // SwapRouter02's "the caller"
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // SwapRouter02's "keep it in the router"
const MAX = 2n ** 256n - 1n;

const ROUTER = new ethers.Interface([
  // SwapRouter02 (no deadline in the struct)
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum))",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96))",
  "function exactOutput((bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum))",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to)",
  "function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] path,address to)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline,bytes[] data)",
  "function multicall(bytes32 previousBlockhash,bytes[] data)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient)",
  "function unwrapWETH9(uint256 amountMinimum)",
  "function sweepToken(address token,uint256 amountMinimum,address recipient)",
  "function sweepToken(address token,uint256 amountMinimum)",
  "function refundETH()",
]);
// The original SwapRouter and the V2 router carry a deadline, so the same
// names decode differently; they get an interface of their own.
const ROUTER_V1 = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum))",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96))",
  "function exactOutput((bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum))",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] path,address to,uint256 deadline)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapTokensForExactETH(uint256 amountOut,uint256 amountInMax,address[] path,address to,uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapETHForExactTokens(uint256 amountOut,address[] path,address to,uint256 deadline)",
]);

const SELECTORS = new Map();
for (const iface of [ROUTER, ROUTER_V1]) iface.forEachFunction((f) => SELECTORS.set(f.selector, { iface, f }));

const addr = (a) => ethers.getAddress(a);
const firstToken = (path) => addr(ethers.dataSlice(path, 0, 20));
const lastToken = (path) => addr(ethers.dataSlice(path, ethers.dataLength(path) - 20));

/// A router call as { spends: [{ token, raw }], sends: [address], keeps: bool,
/// sweeps: [address] }, or null when `data` is not a router call Rein reads.
/// `sends` are swap recipients; `keeps` says some output stays in the router
/// for a later step; `sweeps` are where unwrap/sweep steps send what it holds.
function readRouterCall(data, depth = 0) {
  const hit = SELECTORS.get(data.slice(0, 10).toLowerCase());
  if (!hit || depth > 3) return null;
  let a;
  try {
    a = hit.iface.decodeFunctionData(hit.f, data);
  } catch {
    return null;
  }
  const out = { spends: [], sends: [], sweeps: [] };
  const name = hit.f.name;
  const p = a[0];
  if (name === "multicall") {
    for (const inner of a[a.length - 1]) {
      const r = readRouterCall(inner, depth + 1);
      if (!r) return { ...out, unreadable: true };
      out.spends.push(...r.spends);
      out.sends.push(...r.sends);
      out.sweeps.push(...r.sweeps);
      if (r.unreadable) out.unreadable = true;
    }
  } else if (name === "exactInputSingle") out.spends.push({ token: addr(p.tokenIn), raw: p.amountIn }), out.sends.push(addr(p.recipient));
  else if (name === "exactOutputSingle") out.spends.push({ token: addr(p.tokenIn), raw: p.amountInMaximum }), out.sends.push(addr(p.recipient));
  // A V3 path runs tokenIn → tokenOut for exact input, and the other way round for exact output.
  else if (name === "exactInput") out.spends.push({ token: firstToken(p.path), raw: p.amountIn }), out.sends.push(addr(p.recipient));
  else if (name === "exactOutput") out.spends.push({ token: lastToken(p.path), raw: p.amountInMaximum }), out.sends.push(addr(p.recipient));
  else if (name.startsWith("swapExactETH") || name.startsWith("swapETHFor")) out.sends.push(addr(a.to));
  else if (name.startsWith("swapExact")) out.spends.push({ token: addr(a.path[0]), raw: a.amountIn }), out.sends.push(addr(a.to));
  else if (name.startsWith("swapTokensForExact")) out.spends.push({ token: addr(a.path[0]), raw: a.amountInMax }), out.sends.push(addr(a.to));
  else if (name === "unwrapWETH9" || name === "sweepToken") out.sweeps.push(a.recipient != null ? addr(a.recipient) : MSG_SENDER);
  // refundETH returns leftover ETH to the caller: nothing to hold.
  return out;
}

/// Who a router call pays that isn't the wallet itself, or null if it pays
/// only the wallet. Output kept in the router has to be swept back to the
/// wallet in the same call; left there, anyone could sweep it.
function strangers(r, wallet, router) {
  const self = (x) => x === wallet || x === MSG_SENDER;
  const held = (x) => x === ADDRESS_THIS || x === router;
  const bad = [...r.sends.filter((x) => !self(x) && !held(x)), ...r.sweeps.filter((x) => !self(x))];
  if (r.sends.some(held) && !r.sweeps.some(self)) bad.push(router);
  return bad.length ? [...new Set(bad)] : null;
}

// -- signatures --------------------------------------------------------------------

/// An EIP-712 signature request ({ domain, types, primaryType, message }) as
/// what it lets someone move: { kind: "transfer" | "approve", token, payee,
/// raw }, a list of those, or null if Rein doesn't know what it authorizes.
function readTypedData(td) {
  const m = td.message || {};
  const verifying = td.domain?.verifyingContract ? addr(td.domain.verifyingContract) : null;
  switch (td.primaryType) {
    case "TransferWithAuthorization": // EIP-3009, what x402's "exact" scheme signs
    case "ReceiveWithAuthorization":
      return verifying && [{ kind: "transfer", token: verifying, payee: addr(m.to), raw: BigInt(m.value) }];
    case "Permit": // EIP-2612, or DAI's { allowed: bool }
      if (!verifying) return null;
      if (m.allowed != null) return [{ kind: "approve", token: verifying, payee: addr(m.spender), raw: m.allowed ? MAX : 0n }];
      return [{ kind: "approve", token: verifying, payee: addr(m.spender), raw: BigInt(m.value) }];
    case "PermitSingle": // Permit2 allowance
      return [{ kind: "approve", token: addr(m.details.token), payee: addr(m.spender), raw: BigInt(m.details.amount) }];
    case "PermitBatch":
      return m.details.map((d) => ({ kind: "approve", token: addr(d.token), payee: addr(m.spender), raw: BigInt(d.amount) }));
    // Permit2 signature transfers: the spender may send the tokens anywhere,
    // so they count as an allowance to the spender.
    case "PermitTransferFrom":
    case "PermitWitnessTransferFrom":
      return [{ kind: "approve", token: addr(m.permitted.token), payee: addr(m.spender), raw: BigInt(m.permitted.amount) }];
    case "PermitBatchTransferFrom":
    case "PermitBatchWitnessTransferFrom":
      return m.permitted.map((p) => ({ kind: "approve", token: addr(p.token), payee: addr(m.spender), raw: BigInt(p.amount) }));
    default:
      return null;
  }
}

module.exports = { readRouterCall, strangers, readTypedData, MSG_SENDER, ADDRESS_THIS, ROUTER, ROUTER_V1 };
