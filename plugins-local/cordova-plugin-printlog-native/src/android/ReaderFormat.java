package com.hoffmanengineering.printlog;

/**
 * One validated tag-reading format from the server's reader config. Built only by
 * ReaderConfig.format, so every field has already passed the config caps. Never log it: the
 * salt and info are the config's secrets.
 */
final class ReaderFormat {
    final String id;
    final String scheme;
    final byte[] salt;
    /** Set for hmac-sha256-sector, else null. */
    final String labelPrefix;
    /** Set for hkdf-sha256-sectors, else null. */
    final byte[] info;
    final int sectors;

    ReaderFormat(String id, String scheme, byte[] salt, String labelPrefix, byte[] info, int sectors) {
        this.id = id;
        this.scheme = scheme;
        this.salt = salt;
        this.labelPrefix = labelPrefix;
        this.info = info;
        this.sectors = sectors;
    }
}
