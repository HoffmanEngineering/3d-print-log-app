package com.hoffmanengineering.printlog;

import java.util.Arrays;
import java.util.List;

/**
 * Which tags could be on a spool, and how their UID is written. Plain Java with no Android
 * imports, so test/spool_tag_rules.test.js can compile and run it with javac.
 *
 * The UID format is a contract with the API's TagUid.Normalize and with printer-side readers
 * (OpenPrintTag, printlog-bridge): a phone-linked UID must equal what the printer reports, or
 * GET by-tag misses and the spool gets linked twice under two spellings.
 */
public final class SpoolTagRules {
    static final String TECH_ISO_DEP = "android.nfc.tech.IsoDep";

    private SpoolTagRules() {
    }

    /**
     * @return "nfcv", "nfca", "nfcb" or "nfcf" for a tag that could be on a spool, or null for
     *         one to drop: ISO-DEP tags (payment, transit and ID cards, and phones; spool tags
     *         are MIFARE Classic, NTAG or ISO 15693, never ISO-DEP), tags with no ID, and NFC-A
     *         random IDs, which change on every read.
     */
    public static String spoolTech(String[] techList, byte[] id) {
        if (techList == null || id == null || id.length == 0) {
            return null;
        }

        List<String> techs = Arrays.asList(techList);
        if (techs.contains(TECH_ISO_DEP)) {
            return null;
        }

        String tech;
        if (techs.contains("android.nfc.tech.NfcV")) {
            tech = "nfcv";
        } else if (techs.contains("android.nfc.tech.NfcA")) {
            tech = "nfca";
        } else if (techs.contains("android.nfc.tech.NfcB")) {
            tech = "nfcb";
        } else if (techs.contains("android.nfc.tech.NfcF")) {
            tech = "nfcf";
        } else {
            return null;
        }

        // ISO 14443-3: a 4-byte UID starting 0x08 is a random ID, new on every read.
        if ("nfca".equals(tech) && id.length == 4 && (id[0] & 0xFF) == 0x08) {
            return null;
        }
        return tech;
    }

    /** Why spoolTech dropped a tag, for logcat. Never includes the UID. */
    public static String dropReason(String[] techList, byte[] id) {
        if (techList == null || id == null || id.length == 0) {
            return "no id";
        }
        List<String> techs = Arrays.asList(techList);
        if (techs.contains(TECH_ISO_DEP)) {
            return "iso-dep";
        }
        if (techs.contains("android.nfc.tech.NfcA") && !techs.contains("android.nfc.tech.NfcV")
                && id.length == 4 && (id[0] & 0xFF) == 0x08) {
            return "random id";
        }
        return "no spool tech";
    }

    /**
     * Uppercase hex with no separators, as TagUid.Normalize stores it. Android returns an
     * ISO 15693 UID least significant byte first; reversed, it reads in the printed E0... order
     * that OpenPrintTag readers report.
     */
    public static String uid(byte[] id, String tech) {
        boolean reverse = "nfcv".equals(tech);
        StringBuilder hex = new StringBuilder(id.length * 2);
        for (int i = 0; i < id.length; i++) {
            byte b = id[reverse ? id.length - 1 - i : i];
            hex.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xF, 16)));
            hex.append(Character.toUpperCase(Character.forDigit(b & 0xF, 16)));
        }
        return hex.toString();
    }

    /** Command-line entry for the node test: args are hex id, then tech-list entries. */
    public static void main(String[] args) {
        byte[] id = new byte[args[0].length() / 2];
        for (int i = 0; i < id.length; i++) {
            id[i] = (byte) Integer.parseInt(args[0].substring(i * 2, i * 2 + 2), 16);
        }
        String[] techs = Arrays.copyOfRange(args, 1, args.length);
        String tech = spoolTech(techs, id);
        System.out.println(tech == null ? "drop " + dropReason(techs, id) : tech + " " + uid(id, tech));
    }
}
