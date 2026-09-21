// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Erc3009Gate
/// @notice Reconstructs the EIP-712 digest a token will compute for an ERC-3009
///         signed transfer, so an account can decide about that transfer before
///         the transfer exists.
///
/// This is the piece that lets a policy-bound smart account pay over x402.
/// x402's `exact` scheme on EVM settles by having a facilitator call
/// `transferWithAuthorization` on the token with a signature the payer produced
/// off-chain. An EOA signs that with its private key. A contract cannot sign
/// anything -- which is why, with no support for this, a smart account simply
/// cannot be an x402 payer, and every bounded-authority account is locked out
/// of the one agent payment rail that has volume.
///
/// ERC-7598 is the way through, and it is already live in USDC's FiatTokenV2_2:
/// when the payer is a contract, the token routes the signature to the payer's
/// ERC-1271 `isValidSignature` instead of ecrecover. So the account is asked, at
/// settlement time, whether it stands behind a digest. If the account has
/// already checked that exact transfer against its policy, it says yes.
///
/// The useful consequence is that the check is live at settlement rather than
/// at signing time. A pending x402 payment can still be stopped, because the
/// token comes back and asks. That is not true of a signature from an EOA.
library Erc3009Gate {
    /// @dev EIP-712 type hashes, verbatim from ERC-3009.
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @notice The ERC-1271 success value.
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant NOT_VALID = 0xffffffff;

    struct Authorization {
        address token;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    /// @notice The digest `token` will hash and ask this account to stand behind.
    /// @param receiveVariant True for `receiveWithAuthorization`, which some
    ///        facilitators prefer because it pins the caller and so cannot be
    ///        front-run. The two differ only in the type hash.
    /// @dev The token's own domain separator is read from the token rather than
    ///      reconstructed, because reconstructing it means guessing the token's
    ///      name, version and how it handles a chain id change after a fork.
    ///      Guessing wrong produces a digest nobody will ever present, which
    ///      fails closed but wastes the owner's budget; reading is exact.
    function digestOf(Authorization memory a, address from, bool receiveVariant)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = domainSeparatorOf(a.token);
        if (domain == bytes32(0)) return bytes32(0);

        bytes32 structHash = keccak256(
            abi.encode(
                receiveVariant
                    ? RECEIVE_WITH_AUTHORIZATION_TYPEHASH
                    : TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                a.to,
                a.value,
                a.validAfter,
                a.validBefore,
                a.nonce
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    /// @notice `DOMAIN_SEPARATOR()` on the token, or zero if it has none.
    /// @dev Zero is the honest answer for a token that does not implement
    ///      ERC-3009 at all, and the caller is expected to refuse on it rather
    ///      than approve a digest that can never be presented.
    function domainSeparatorOf(address token) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x3644e515));
        return (ok && ret.length >= 32) ? abi.decode(ret, (bytes32)) : bytes32(0);
    }
}
