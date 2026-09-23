// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title TalkRegistry: sellos permanentes de recibos de testalk
/// @notice Guarda, por cada recibo firmado, su huella, la llave que lo firmó, la
///         firma y el CID. Bulletin borra el recibo a los 14 días; este registro
///         no expira.
/// @dev Qué aporta cada campo a la verificación:
///      - `receiptHash` (blake2b-256 de los bytes del recibo, el digest de su CID)
///        permite comprobar que un JSON conservado es exactamente el sellado.
///      - `blockNumber` y `sealedAt` son la cota SUPERIOR de tiempo: el recibo
///        existía a más tardar en este bloque. Los block hashes dentro del
///        recibo dan la cota inferior.
///      - `pubkey` y `sig` dejan la autoría on-chain: la firma sr25519 se
///        verifica fuera, contra los bytes canónicos del recibo.
///
///      El contrato NO verifica la firma ni exige que el llamante sea el
///      speaker. No hace falta: un sello con firma falsa no valida en ningún
///      verificador, y que un tercero ancle el recibo de otro solo le agrega
///      una cota de tiempo. Lo primero que se ancla gana; no se sobrescribe.
contract TalkRegistry {
    struct Seal {
        bytes32 pubkey;
        uint64 blockNumber;
        uint64 sealedAt;
        uint32 anchorBlock;
        address submitter;
        bytes sig;
        string cid;
        string title;
    }

    mapping(bytes32 => Seal) private seals;
    bytes32[] private hashes;

    event Sealed(bytes32 indexed receiptHash, bytes32 indexed pubkey, uint32 anchorBlock, string cid);

    error AlreadySealed(bytes32 receiptHash);
    error BadSignatureLength(uint256 length);
    error FieldTooLong(string field);
    error EmptyHash();

    /// @param receiptHash blake2b-256 de los bytes del recibo
    /// @param pubkey      llave sr25519 del firmante
    /// @param sig         firma sr25519 de 64 bytes
    /// @param anchorBlock primer bloque del recibo (cota inferior de tiempo)
    /// @param cid         CID en Bulletin, para quien aún pueda resolverlo
    /// @param title       título de la charla, para listar sin descargar nada
    function seal(
        bytes32 receiptHash,
        bytes32 pubkey,
        bytes calldata sig,
        uint32 anchorBlock,
        string calldata cid,
        string calldata title
    ) external {
        if (receiptHash == bytes32(0)) revert EmptyHash();
        if (seals[receiptHash].submitter != address(0)) revert AlreadySealed(receiptHash);
        if (sig.length != 64) revert BadSignatureLength(sig.length);
        if (bytes(cid).length > 100) revert FieldTooLong("cid");
        if (bytes(title).length > 200) revert FieldTooLong("title");

        seals[receiptHash] = Seal({
            pubkey: pubkey,
            blockNumber: uint64(block.number),
            sealedAt: uint64(block.timestamp),
            anchorBlock: anchorBlock,
            submitter: msg.sender,
            sig: sig,
            cid: cid,
            title: title
        });
        hashes.push(receiptHash);
        emit Sealed(receiptHash, pubkey, anchorBlock, cid);
    }

    /// @notice Sello de un recibo. `submitter == address(0)` significa que no existe.
    function get(bytes32 receiptHash) external view returns (Seal memory) {
        return seals[receiptHash];
    }

    function total() external view returns (uint256) {
        return hashes.length;
    }

    /// @notice Huellas en orden de sellado, para listar sin eventos.
    function page(uint256 start, uint256 count) external view returns (bytes32[] memory out) {
        uint256 n = hashes.length;
        if (start >= n) return new bytes32[](0);
        uint256 end = start + count > n ? n : start + count;
        out = new bytes32[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = hashes[i];
    }
}
