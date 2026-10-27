import Foundation

/// Which tags could be on a spool, how their UID is written, and how read memory is packaged:
/// the iOS counterpart of SpoolTagRules.java and PageDump.java. Foundation only, so CI's ios
/// job compiles it with test/ios/main.swift and runs it with plain swiftc.
///
/// The UID format is a contract with the API's TagUid.Normalize and with printer-side readers:
/// a phone-linked UID must equal what the printer reports, or the spool gets linked twice under
/// two spellings.
enum SpoolTagRulesIOS {
    static let type2MaxBytes = 1024
    static let nfcvMaxBytes = 2048

    /// The family of an NFC-A tag as Core NFC reports it, reduced to what the rules need.
    enum MiFareFamily {
        /// NTAG and Ultralight: Type 2, readable page by page.
        case ultralight
        /// DESFire and Plus: ISO-DEP, like payment and transit cards. Never a spool tag.
        case isoDep
        /// Core NFC could not tell. Often MIFARE Classic, which iPhones cannot read.
        case unknown
    }

    /// Uppercase hex with no separators, as TagUid.Normalize stores it.
    static func hex(_ bytes: Data) -> String {
        bytes.map { String(format: "%02X", $0) }.joined()
    }

    /// The NFC-A UID, or nil to drop the tag: empty, an ISO-DEP family, or a 4-byte random ID
    /// starting 0x08 (ISO 14443-3), which changes on every read.
    static func nfcaUid(_ identifier: Data, family: MiFareFamily) -> String? {
        if identifier.isEmpty || family == .isoDep {
            return nil
        }
        if identifier.count == 4 && identifier.first == 0x08 {
            return nil
        }
        return hex(identifier)
    }

    /// The ISO 15693 UID in its printed `E0…` order, the order printer-side readers report.
    /// The most significant byte of every ISO 15693 UID is 0xE0, so whichever end holds it is
    /// the front: this holds whether Core NFC hands the bytes over in either order, which
    /// Apple does not document.
    static func nfcvUid(_ identifier: Data) -> String? {
        guard !identifier.isEmpty else { return nil }
        if identifier.first == 0xE0 {
            return hex(identifier)
        }
        if identifier.last == 0xE0 {
            return hex(Data(identifier.reversed()))
        }
        return hex(identifier)
    }

    /// The `memory` object the shim accepts, or nil when nothing was read. Truncated to the
    /// kind's cap, like PageDump, so a tag that answers past it cannot grow the payload.
    static func memory(kind: String, data: Data) -> [String: Any]? {
        let cap = kind == "nfcv" ? nfcvMaxBytes : type2MaxBytes
        let bytes = data.prefix(cap)
        if bytes.isEmpty {
            return nil
        }
        return ["kind": kind, "data": Data(bytes).base64EncodedString()]
    }
}
