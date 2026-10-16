package com.hoffmanengineering.printlog;

import android.nfc.Tag;
import android.nfc.tech.MifareClassic;
import android.nfc.tech.NfcA;
import android.nfc.tech.NfcV;
import android.nfc.tech.TagTechnology;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;

/**
 * Reads a spool tag's memory within a time budget: MIFARE Classic sectors with keys derived from
 * the reader config, NFC Forum Type 2 pages over raw NfcA, NFC-V blocks. Pure I/O; the parsing
 * happens in the API. Never logs memory, keys or the config, and never throws: whatever was read
 * before a failure or the deadline is returned.
 */
final class TagReader {
    static final String KIND_CLASSIC = "classic";
    static final String KIND_TYPE2 = "type2";
    static final String KIND_NFCV = "nfcv";

    /** Classic 1K: the API takes exactly 16 sectors x 64 bytes. */
    private static final int CLASSIC_SECTORS = 16;
    private static final int CLASSIC_BLOCKS_PER_SECTOR = 4;
    private static final int TYPE2_MAX_BYTES = 1024;
    private static final int NFCV_MAX_BYTES = 2048;

    private static final byte TYPE2_READ = 0x30;
    /** One READ returns four 4-byte pages. */
    private static final int TYPE2_READ_BYTES = 16;
    private static final int TYPE2_LAST_PAGE = 0xFF;

    /** ISO 15693 request flags: high data rate, addressed. */
    private static final byte NFCV_FLAGS = 0x22;
    private static final byte NFCV_GET_SYSTEM_INFO = 0x2B;
    private static final byte NFCV_READ_MULTIPLE_BLOCKS = 0x23;
    /** Chunk size in blocks when GET_SYSTEM_INFO does not give a block size. */
    private static final int NFCV_DEFAULT_CHUNK_BLOCKS = 32;
    /** Bytes asked for per READ_MULTIPLE_BLOCKS when the block size is known. */
    private static final int NFCV_CHUNK_BYTES = 128;
    private static final int MIN_OP_TIMEOUT_MS = 120;
    private static final int NFCV_MAX_BLOCKS = 256;

    private TagReader() {
    }

    /**
     * @param formats the session's reader-config formats, or null when the page passed no config:
     *                then nothing past the UID is read, as before tag memory reading existed.
     * @return { uid, tech, techs, classicUnsupported?, memory? }, or null for a tag to drop
     *         (the same tags PrintLogNativePlugin.describeSpoolTag drops).
     */
    static JSONObject read(Tag tag, List<ReaderFormat> formats, long budgetMs) {
        long deadline = System.currentTimeMillis() + budgetMs;
        JSONObject json = PrintLogNativePlugin.describeSpoolTag(tag);
        if (json == null) {
            return null;
        }
        try {
            JSONArray techs = new JSONArray();
            for (String t : tag.getTechList()) {
                techs.put(t);
            }
            json.put("techs", techs);

            NfcA nfcA = NfcA.get(tag);
            if (nfcA != null && SpoolTagRules.classicUnsupported(nfcA.getSak(), tag.getTechList())) {
                json.put("classicUnsupported", true);
                return json;
            }
            if (formats == null) {
                return json;
            }

            JSONObject memory = null;
            MifareClassic classic = MifareClassic.get(tag);
            if (classic != null) {
                memory = readClassic(classic, tag.getId(), formats, deadline);
            } else if ("nfca".equals(json.optString("tech")) && nfcA != null && nfcA.getSak() == 0x00) {
                memory = readType2(nfcA, deadline);
            } else if ("nfcv".equals(json.optString("tech"))) {
                NfcV nfcV = NfcV.get(tag);
                if (nfcV != null) {
                    memory = readNfcV(nfcV, tag.getId(), deadline);
                }
            }
            if (memory != null) {
                json.put("memory", memory);
            }
        } catch (Exception e) {
            // Return what is already in json: the UID at least.
        }
        return json;
    }

    /**
     * The first format whose sector-0 key A authenticates is the tag's key format; its keys are
     * used for the remaining sectors. No format authenticating means no memory.
     */
    private static JSONObject readClassic(MifareClassic mc, byte[] uid, List<ReaderFormat> formats,
                                          long deadline) {
        if (formats.isEmpty()) {
            return null;
        }
        ClassicDump dump = new ClassicDump(CLASSIC_SECTORS);
        boolean[] read = new boolean[CLASSIC_SECTORS];
        byte[][] keys = null;
        int sectors = 0;
        try {
            mc.connect();
            bound(mc, deadline);
            for (ReaderFormat format : formats) {
                if (expired(deadline)) {
                    break;
                }
                byte[][] candidate;
                try {
                    candidate = keys(format, uid);
                } catch (RuntimeException e) {
                    continue;
                }
                if (candidate == null) {
                    continue;
                }
                if (authenticate(mc, 0, candidate[0], deadline)) {
                    keys = candidate;
                    dump.keyFormat = format.id;
                    sectors = Math.min(Math.min(format.sectors, keys.length),
                            Math.min(mc.getSectorCount(), CLASSIC_SECTORS));
                    break;
                }
            }
            if (keys == null) {
                return null;
            }
            for (int s = 0; s < sectors && !expired(deadline); s++) {
                // Sector 0 was just authenticated by the format search.
                if (s > 0 && !authenticate(mc, s, keys[s], deadline)) {
                    continue;
                }
                byte[] sector = readSector(mc, s);
                if (sector == null) {
                    reconnect(mc, deadline);
                    continue;
                }
                dump.putSector(s, sector);
                read[s] = true;
            }
        } catch (Exception e) {
            // Keep the sectors read so far.
        } finally {
            close(mc);
        }
        if (dump.keyFormat == null) {
            return null;
        }
        for (int s = 0; s < CLASSIC_SECTORS; s++) {
            if (!read[s]) {
                dump.markUnreadable(s);
            }
        }
        return memory(KIND_CLASSIC, dump.bytes(), dump.keyFormat, dump.unreadable());
    }

    private static byte[][] keys(ReaderFormat format, byte[] uid) {
        if (ReaderConfig.SCHEME_HMAC.equals(format.scheme)) {
            return TagKeySchemes.hmacSha256Sector(uid, format.salt, format.labelPrefix, format.sectors);
        }
        if (ReaderConfig.SCHEME_HKDF.equals(format.scheme)) {
            return TagKeySchemes.hkdfSha256Sectors(uid, format.salt, format.info, format.sectors);
        }
        return null;
    }

    /** A failed authentication halts the card, so it reconnects before returning false. */
    private static boolean authenticate(MifareClassic mc, int sector, byte[] key, long deadline) {
        try {
            if (mc.authenticateSectorWithKeyA(sector, key)) {
                return true;
            }
        } catch (IOException e) {
            // Reconnect below.
        }
        reconnect(mc, deadline);
        return false;
    }

    /** The sector's four blocks, trailer included, or null when a block read fails. */
    private static byte[] readSector(MifareClassic mc, int sector) {
        byte[] out = new byte[ClassicDump.SECTOR_BYTES];
        int first = mc.sectorToBlock(sector);
        try {
            for (int b = 0; b < CLASSIC_BLOCKS_PER_SECTOR; b++) {
                byte[] block = mc.readBlock(first + b);
                if (block == null || block.length < MifareClassic.BLOCK_SIZE) {
                    return null;
                }
                System.arraycopy(block, 0, out, b * MifareClassic.BLOCK_SIZE, MifareClassic.BLOCK_SIZE);
            }
        } catch (IOException e) {
            return null;
        }
        return out;
    }

    /**
     * READ (0x30) over raw NfcA, four pages at a time from page 0. Raw NfcA rather than
     * MifareUltralight because some spool chips answer Type 2 reads without that tech.
     */
    private static JSONObject readType2(NfcA nfcA, long deadline) {
        PageDump dump = new PageDump(TYPE2_MAX_BYTES);
        try {
            nfcA.connect();
            bound(nfcA, deadline);
            for (int page = 0; page <= TYPE2_LAST_PAGE && !expired(deadline); page += 4) {
                byte[] data = nfcA.transceive(new byte[] {TYPE2_READ, (byte) page});
                if (data == null || data.length < TYPE2_READ_BYTES) {
                    break;
                }
                if (!dump.add(Arrays.copyOf(data, TYPE2_READ_BYTES))) {
                    break;
                }
            }
        } catch (Exception e) {
            // Past the end of memory, or the tag left the field: keep what was read.
        } finally {
            close(nfcA);
        }
        return pageMemory(KIND_TYPE2, dump);
    }

    /** READ_MULTIPLE_BLOCKS (0x23) addressed with the UID, 32 blocks at a time from block 0. */
    private static JSONObject readNfcV(NfcV nfcV, byte[] id, long deadline) {
        PageDump dump = new PageDump(NFCV_MAX_BYTES);
        try {
            nfcV.connect();
            int[] layout = blockLayout(nfcV, id);
            int blocks = layout[0];
            int chunk = layout[1] > 0 ? Math.max(1, NFCV_CHUNK_BYTES / layout[1]) : NFCV_DEFAULT_CHUNK_BLOCKS;
            for (int first = 0; first < blocks && !expired(deadline); first += chunk) {
                    int count = Math.min(chunk, blocks - first);
                byte[] reply = nfcV.transceive(addressed(NFCV_READ_MULTIPLE_BLOCKS, id,
                        new byte[] {(byte) first, (byte) (count - 1)}));
                // Byte 0 is the response flags; bit 0 set means an error code follows.
                if (reply == null || reply.length < 2 || (reply[0] & 0x01) != 0) {
                    break;
                }
                if (!dump.add(Arrays.copyOfRange(reply, 1, reply.length))) {
                    break;
                }
            }
        } catch (Exception e) {
            // The tag left the field or refused a read: keep what was read.
        } finally {
            close(nfcV);
        }
        return pageMemory(KIND_NFCV, dump);
    }

    /**
     * { block count, block size in bytes } from GET_SYSTEM_INFO, so the last chunk asks only for
     * blocks that exist (asking past the end fails the whole chunk). 256 blocks and size 0
     * (unknown) when the tag does not say.
     */
    private static int[] blockLayout(NfcV nfcV, byte[] id) {
        try {
            byte[] info = nfcV.transceive(addressed(NFCV_GET_SYSTEM_INFO, id, null));
            // Flags, info flags, UID (8), then DSFID, AFI and memory size when their bits are set.
            if (info == null || info.length < 10 || (info[0] & 0x01) != 0) {
                return new int[] {NFCV_MAX_BLOCKS, 0};
            }
            int infoFlags = info[1];
            int p = 10;
            if ((infoFlags & 0x01) != 0) {
                p++;
            }
            if ((infoFlags & 0x02) != 0) {
                p++;
            }
            if ((infoFlags & 0x04) != 0 && info.length > p) {
                int size = info.length > p + 1 ? (info[p + 1] & 0x1F) + 1 : 0;
                return new int[] {(info[p] & 0xFF) + 1, size};
            }
        } catch (IOException e) {
            // Some tags do not implement it; read until an error instead.
        }
        return new int[] {NFCV_MAX_BLOCKS, 0};
    }

    private static byte[] addressed(byte command, byte[] id, byte[] args) {
        int argLength = args == null ? 0 : args.length;
        byte[] out = new byte[2 + id.length + argLength];
        out[0] = NFCV_FLAGS;
        out[1] = command;
        System.arraycopy(id, 0, out, 2, id.length);
        if (args != null) {
            System.arraycopy(args, 0, out, 2 + id.length, argLength);
        }
        return out;
    }

    private static JSONObject pageMemory(String kind, PageDump dump) {
        byte[] bytes = dump.bytes();
        return bytes.length == 0 ? null : memory(kind, bytes, null, null);
    }

    private static JSONObject memory(String kind, byte[] data, String keyFormat, int[] unreadable) {
        try {
            JSONObject memory = new JSONObject();
            memory.put("kind", kind);
            memory.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
            if (keyFormat != null) {
                memory.put("keyFormat", keyFormat);
            }
            if (unreadable != null) {
                JSONArray sectors = new JSONArray();
                for (int s : unreadable) {
                    sectors.put(s);
                }
                memory.put("unreadable", sectors);
            }
            return memory;
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean expired(long deadline) {
        return System.currentTimeMillis() >= deadline;
    }

    /** Caps one transceive so a stuck tag cannot eat more than the time left (at least 120 ms). */
    private static void bound(TagTechnology tech, long deadline) {
        long remaining = deadline - System.currentTimeMillis();
        int timeout = (int) Math.min(Integer.MAX_VALUE, Math.max(MIN_OP_TIMEOUT_MS, remaining));
        try {
            if (tech instanceof MifareClassic) {
                ((MifareClassic) tech).setTimeout(timeout);
            } else if (tech instanceof NfcA) {
                ((NfcA) tech).setTimeout(timeout);
            }
            // NfcV has no setTimeout: its transceive keeps the platform default.
        } catch (RuntimeException e) {
            // Keep the platform default.
        }
    }

    private static void reconnect(MifareClassic mc, long deadline) {
        try {
            mc.close();
            mc.connect();
            bound(mc, deadline);
        } catch (IOException e) {
            // The next call on mc fails and that sector is marked unreadable.
        }
    }

    private static void close(TagTechnology tech) {
        try {
            tech.close();
        } catch (IOException e) {
            // Nothing to do.
        }
    }
}
