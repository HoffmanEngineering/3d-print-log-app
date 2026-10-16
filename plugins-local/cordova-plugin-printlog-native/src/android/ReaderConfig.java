package com.hoffmanengineering.printlog;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validates the reader config the page hands native. The page is not trusted, so anything that
 * breaks the caps is dropped rather than repaired. Plain Java with no Android imports, so
 * test/reader_config.test.js can compile and run it with javac. Never logs params.
 */
final class ReaderConfig {
    static final String SCHEME_HMAC = "hmac-sha256-sector";
    static final String SCHEME_HKDF = "hkdf-sha256-sectors";
    static final int MAX_FORMATS = 8;
    static final int MAX_VALUE_LENGTH = 256;
    static final int MIN_SECTORS = 1;
    static final int MAX_SECTORS = 16;

    private static final Pattern ID = Pattern.compile("^[a-z0-9-]{1,50}$");
    private static final Pattern HEX = Pattern.compile("^([0-9a-fA-F]{2})+$");
    private static final Pattern SECTORS = Pattern.compile("^[0-9]{1,3}$");
    private static final Pattern PRINTABLE_ASCII = Pattern.compile("^[\\x20-\\x7E]+$");

    private ReaderConfig() {
    }

    /**
     * @return the format, or null when anything breaks the caps: unknown scheme, bad id, a
     *         missing or non-hex or odd-length saltHex or infoHex, a missing or non-ASCII
     *         labelPrefix, a value over 256 characters, or sectors outside 1-16 (default 16).
     */
    static ReaderFormat format(String id, String scheme, Map<String, String> params) {
        if (id == null || !ID.matcher(id).matches() || params == null) {
            return null;
        }
        boolean hmac = SCHEME_HMAC.equals(scheme);
        if (!hmac && !SCHEME_HKDF.equals(scheme)) {
            return null;
        }

        byte[] salt = hexParam(params.get("saltHex"));
        if (salt == null) {
            return null;
        }

        String labelPrefix = null;
        byte[] info = null;
        if (hmac) {
            labelPrefix = params.get("labelPrefix");
            if (labelPrefix == null || labelPrefix.length() > MAX_VALUE_LENGTH
                    || !PRINTABLE_ASCII.matcher(labelPrefix).matches()) {
                return null;
            }
        } else {
            info = hexParam(params.get("infoHex"));
            if (info == null) {
                return null;
            }
        }

        int sectors = MAX_SECTORS;
        String rawSectors = params.get("sectors");
        if (rawSectors != null) {
            if (!SECTORS.matcher(rawSectors).matches()) {
                return null;
            }
            sectors = Integer.parseInt(rawSectors);
            if (sectors < MIN_SECTORS || sectors > MAX_SECTORS) {
                return null;
            }
        }
        return new ReaderFormat(id, scheme, salt, labelPrefix, info, sectors);
    }

    /** Drops nulls and repeated ids (the first wins), then keeps at most 8. */
    static List<ReaderFormat> formats(List<ReaderFormat> candidates) {
        List<ReaderFormat> kept = new ArrayList<ReaderFormat>();
        Set<String> seen = new HashSet<String>();
        if (candidates == null) {
            return kept;
        }
        for (ReaderFormat candidate : candidates) {
            if (candidate == null || !seen.add(candidate.id)) {
                continue;
            }
            kept.add(candidate);
            if (kept.size() == MAX_FORMATS) {
                break;
            }
        }
        return kept;
    }

    private static byte[] hexParam(String value) {
        if (value == null || value.length() > MAX_VALUE_LENGTH || !HEX.matcher(value).matches()) {
            return null;
        }
        return TagKeySchemes.fromHex(value);
    }

    /** Command-line entry for the node test: each arg is id|scheme|k=v;k=v. */
    public static void main(String[] args) {
        List<ReaderFormat> candidates = new ArrayList<ReaderFormat>();
        for (String arg : args) {
            String[] parts = arg.split("\\|", 3);
            Map<String, String> params = new java.util.HashMap<String, String>();
            if (parts.length == 3) {
                for (String pair : parts[2].split(";")) {
                    int eq = pair.indexOf('=');
                    if (eq > 0) {
                        params.put(pair.substring(0, eq), pair.substring(eq + 1));
                    }
                }
            }
            candidates.add(parts.length >= 2 ? format(parts[0], parts[1], params) : null);
        }
        // Print per input line: ok when it survives validation, de-duplication and the cap.
        List<ReaderFormat> kept = formats(candidates);
        for (ReaderFormat candidate : candidates) {
            System.out.println(candidate != null && kept.contains(candidate) ? "ok " + candidate.id : "drop");
        }
    }
}
