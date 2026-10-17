package com.hoffmanengineering.printlog;

import java.util.ArrayList;
import java.util.List;

/**
 * A MIFARE Classic memory image: 64 bytes per sector, trailers included. Sectors that were not
 * read stay zero and are listed by unreadable(), so a partial read is still a full-size dump.
 */
final class ClassicDump {
    static final int SECTOR_BYTES = 64;

    /** Which key format opened the tag (a ReaderFormat id), or null when none did. */
    String keyFormat;

    private final int sectors;
    private final byte[] memory;
    private final boolean[] unreadable;

    ClassicDump(int sectors) {
        if (sectors < 1) {
            throw new IllegalArgumentException("sectors");
        }
        this.sectors = sectors;
        this.memory = new byte[sectors * SECTOR_BYTES];
        this.unreadable = new boolean[sectors];
    }

    void putSector(int sector, byte[] sixtyFourBytes) {
        check(sector);
        if (sixtyFourBytes == null || sixtyFourBytes.length != SECTOR_BYTES) {
            throw new IllegalArgumentException("sector data must be 64 bytes");
        }
        System.arraycopy(sixtyFourBytes, 0, memory, sector * SECTOR_BYTES, SECTOR_BYTES);
        unreadable[sector] = false;
    }

    void markUnreadable(int sector) {
        check(sector);
        java.util.Arrays.fill(memory, sector * SECTOR_BYTES, (sector + 1) * SECTOR_BYTES, (byte) 0);
        unreadable[sector] = true;
    }

    /** Always 64 x sectors bytes. */
    byte[] bytes() {
        return memory.clone();
    }

    /** Sector numbers marked unreadable, ascending. */
    int[] unreadable() {
        List<Integer> marked = new ArrayList<Integer>();
        for (int i = 0; i < sectors; i++) {
            if (unreadable[i]) {
                marked.add(i);
            }
        }
        int[] out = new int[marked.size()];
        for (int i = 0; i < out.length; i++) {
            out[i] = marked.get(i);
        }
        return out;
    }

    private void check(int sector) {
        if (sector < 0 || sector >= sectors) {
            throw new IllegalArgumentException("sector out of range");
        }
    }
}
