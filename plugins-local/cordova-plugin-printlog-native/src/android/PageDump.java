package com.hoffmanengineering.printlog;

import java.io.ByteArrayOutputStream;

/** Pages or blocks read one chunk at a time, up to a byte cap (Type 2 and NFC-V tags). */
final class PageDump {
    private final int maxBytes;
    private final ByteArrayOutputStream memory = new ByteArrayOutputStream();

    PageDump(int maxBytes) {
        this.maxBytes = maxBytes;
    }

    /**
     * Appends the chunk, cutting it at the cap.
     *
     * @return true when the whole chunk fit; false when it was cut or the dump was already full,
     *         which is the caller's cue to stop reading.
     */
    boolean add(byte[] chunk) {
        int room = maxBytes - memory.size();
        if (chunk == null || chunk.length == 0) {
            return room > 0;
        }
        int take = Math.min(room, chunk.length);
        if (take > 0) {
            memory.write(chunk, 0, take);
        }
        return take == chunk.length;
    }

    byte[] bytes() {
        return memory.toByteArray();
    }
}
