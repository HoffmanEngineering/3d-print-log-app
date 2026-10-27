import CoreNFC
import Foundation

/// One Core NFC scan: the system "Ready to Scan" sheet, the first spool-like tag held to the
/// phone, its UID and whatever memory iOS can read, then the sheet closes. The iOS counterpart
/// of TagReader.java, within what Core NFC allows:
///
/// - There is no passive reader mode. Every read is a user-started session with a system
///   sheet, so the plugin starts one only from the page's scanTag(), never from
///   startTagReading() (#32, and the UI's Scan button in HoffmanEngineering/3d-print-log-ui#365).
/// - MIFARE Classic cannot be read at all, so there are no key formats: Type 2 (NTAG) and
///   ISO 15693 memory is read raw, as on Android, and a Classic tag gives its UID at most.
///
/// Never logs a UID or memory.
final class SpoolTagScanner: NSObject, NFCTagReaderSessionDelegate {
    private static let readBudget: TimeInterval = 1.5
    private static let type2ReadCommand: UInt8 = 0x30
    private static let type2LastPage = 0xFF
    private static let nfcvChunkBlocks = 32
    private static let nfcvMaxBlocks = 256

    /// A tag is under the phone and its memory is being read.
    var onReading: (() -> Void)?
    /// The finished read: `{uid, tech, techs, memory?}` in the shim's shape.
    var onTag: (([String: Any]) -> Void)?

    private let queue = DispatchQueue(label: "com.hoffmanengineering.printlog.nfc")
    private var session: NFCTagReaderSession?

    static var available: Bool {
        NFCTagReaderSession.readingAvailable
    }

    func begin() {
        queue.async {
            guard Self.available, self.session == nil,
                  let session = NFCTagReaderSession(
                      pollingOption: [.iso14443, .iso15693], delegate: self, queue: self.queue)
            else {
                return
            }
            session.alertMessage = "Hold the top of your iPhone near the spool's tag."
            self.session = session
            session.begin()
        }
    }

    func cancel() {
        queue.async {
            self.session?.invalidate()
            self.session = nil
        }
    }

    // MARK: - NFCTagReaderSessionDelegate (called on `queue`)

    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        // Cancelled, timed out after 60 s, or closed after a read: all end the same way.
        if self.session === session {
            self.session = nil
        }
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard let tag = tags.first(where: { Self.candidate($0) != nil }),
              let found = Self.candidate(tag)
        else {
            // ISO-DEP cards, random IDs, phones: keep looking, as Android drops them silently.
            session.restartPolling()
            return
        }

        session.connect(to: tag) { error in
            if error != nil {
                session.invalidate(errorMessage: "Couldn't read that tag. Try again.")
                return
            }

            self.onReading?()
            let deadline = Date().addingTimeInterval(Self.readBudget)
            Self.readMemory(tag, deadline: deadline) { memory in
                var result: [String: Any] = [
                    "uid": found.uid, "tech": found.tech, "techs": Self.techs(tag),
                ]
                if let memory = memory {
                    result["memory"] = memory
                }
                session.alertMessage = "Spool tag read."
                session.invalidate()
                self.onTag?(result)
            }
        }
    }

    // MARK: - Rules

    /// The UID and tech for a tag that could be on a spool, or nil to skip it.
    private static func candidate(_ tag: NFCTag) -> (uid: String, tech: String)? {
        switch tag {
        case .miFare(let mifare):
            return SpoolTagRulesIOS.nfcaUid(mifare.identifier, family: family(mifare))
                .map { ($0, "nfca") }
        case .iso15693(let nfcv):
            return SpoolTagRulesIOS.nfcvUid(nfcv.identifier).map { ($0, "nfcv") }
        case .iso7816, .feliCa:
            return nil
        @unknown default:
            return nil
        }
    }

    private static func family(_ tag: NFCMiFareTag) -> SpoolTagRulesIOS.MiFareFamily {
        switch tag.mifareFamily {
        case .ultralight: return .ultralight
        case .plus, .desfire: return .isoDep
        default: return .unknown
        }
    }

    /// Diagnostics only: the API stores it beside a failed read.
    private static func techs(_ tag: NFCTag) -> [String] {
        switch tag {
        case .miFare(let mifare):
            switch mifare.mifareFamily {
            case .ultralight: return ["CoreNFC.MiFare", "Ultralight"]
            case .plus: return ["CoreNFC.MiFare", "Plus"]
            case .desfire: return ["CoreNFC.MiFare", "DESFire"]
            default: return ["CoreNFC.MiFare", "Unknown"]
            }
        case .iso15693: return ["CoreNFC.ISO15693"]
        case .iso7816: return ["CoreNFC.ISO7816"]
        case .feliCa: return ["CoreNFC.FeliCa"]
        @unknown default: return ["CoreNFC"]
        }
    }

    // MARK: - Memory

    private static func readMemory(
        _ tag: NFCTag, deadline: Date, completion: @escaping ([String: Any]?) -> Void
    ) {
        switch tag {
        case .miFare(let mifare) where mifare.mifareFamily == .ultralight:
            readType2(mifare, page: 0, into: Data(), deadline: deadline) {
                completion(SpoolTagRulesIOS.memory(kind: "type2", data: $0))
            }
        case .iso15693(let nfcv):
            readNfcV(nfcv, block: 0, into: Data(), deadline: deadline) {
                completion(SpoolTagRulesIOS.memory(kind: "nfcv", data: $0))
            }
        default:
            completion(nil)
        }
    }

    /// READ (0x30), four pages (16 bytes) at a time from page 0, until the tag refuses, the
    /// cap or the deadline. Partial results are kept, as on Android.
    private static func readType2(
        _ tag: NFCMiFareTag, page: Int, into memory: Data, deadline: Date,
        completion: @escaping (Data) -> Void
    ) {
        if page > type2LastPage || memory.count >= SpoolTagRulesIOS.type2MaxBytes
            || Date() >= deadline {
            completion(memory)
            return
        }
        tag.sendMiFareCommand(commandPacket: Data([type2ReadCommand, UInt8(page)])) { reply, error in
            // A NAK is a single byte; a page read answers 16.
            guard error == nil, reply.count == 16 else {
                completion(memory)
                return
            }
            readType2(
                tag, page: page + 4, into: memory + reply, deadline: deadline,
                completion: completion)
        }
    }

    /// READ_MULTIPLE_BLOCKS from block 0 in chunks, until the tag refuses, the cap or the
    /// deadline. The block size comes from the replies themselves.
    private static func readNfcV(
        _ tag: NFCISO15693Tag, block: Int, into memory: Data, deadline: Date,
        completion: @escaping (Data) -> Void
    ) {
        if block >= nfcvMaxBlocks || memory.count >= SpoolTagRulesIOS.nfcvMaxBytes
            || Date() >= deadline {
            completion(memory)
            return
        }
        let count = min(nfcvChunkBlocks, nfcvMaxBlocks - block)
        tag.readMultipleBlocks(
            requestFlags: [.highDataRate, .address],
            blockRange: NSRange(location: block, length: count)
        ) { blocks, error in
            guard error == nil, !blocks.isEmpty else {
                completion(memory)
                return
            }
            readNfcV(
                tag, block: block + blocks.count,
                into: memory + blocks.reduce(Data(), +), deadline: deadline,
                completion: completion)
        }
    }
}
