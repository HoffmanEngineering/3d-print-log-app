package com.hoffmanengineering.printlog;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Derives per-sector MIFARE Classic keys from a configured scheme. Plain Java with no Android
 * imports, so test/tag_key_schemes.test.js can compile and run it with javac. The salt, label
 * prefix and info all come from the server's reader config; nothing key-like lives here.
 */
public final class TagKeySchemes {
    static final int KEY_LENGTH = 6;
    private static final String HMAC = "HmacSHA256";
    private static final int HASH_LENGTH = 32;

    private TagKeySchemes() {
    }

    /**
     * Per sector n: PRK = HMAC-SHA256(salt, uid); key = HMAC-SHA256(PRK, ASCII(labelPrefix + n)
     * then 0x01), first 6 bytes. That is HKDF-SHA256 with info labelPrefix + n and length 6.
     */
    public static byte[][] hmacSha256Sector(byte[] uid, byte[] salt, String labelPrefix, int sectors) {
        byte[] prk = extract(salt, uid);
        byte[][] keys = new byte[sectors][];
        for (int n = 0; n < sectors; n++) {
            byte[] info = (labelPrefix + n).getBytes(StandardCharsets.US_ASCII);
            byte[] data = new byte[info.length + 1];
            System.arraycopy(info, 0, data, 0, info.length);
            data[info.length] = 0x01;
            keys[n] = firstKey(hmac(prk, data));
        }
        return keys;
    }

    /** HKDF-SHA256(ikm = uid, salt, info, L = 6 x sectors), split into 6-byte keys. */
    public static byte[][] hkdfSha256Sectors(byte[] uid, byte[] salt, byte[] info, int sectors) {
        byte[] prk = extract(salt, uid);
        int length = KEY_LENGTH * sectors;
        ByteArrayOutputStream okm = new ByteArrayOutputStream();
        byte[] previous = new byte[0];
        for (int counter = 1; okm.size() < length; counter++) {
            byte[] data = new byte[previous.length + info.length + 1];
            System.arraycopy(previous, 0, data, 0, previous.length);
            System.arraycopy(info, 0, data, previous.length, info.length);
            data[data.length - 1] = (byte) counter;
            previous = hmac(prk, data);
            okm.write(previous, 0, previous.length);
        }
        byte[] all = okm.toByteArray();
        byte[][] keys = new byte[sectors][KEY_LENGTH];
        for (int n = 0; n < sectors; n++) {
            System.arraycopy(all, n * KEY_LENGTH, keys[n], 0, KEY_LENGTH);
        }
        return keys;
    }

    private static byte[] extract(byte[] salt, byte[] ikm) {
        // RFC 5869: an empty salt means a string of zero bytes, one hash long.
        return hmac(salt.length == 0 ? new byte[HASH_LENGTH] : salt, ikm);
    }

    private static byte[] firstKey(byte[] mac) {
        byte[] key = new byte[KEY_LENGTH];
        System.arraycopy(mac, 0, key, 0, KEY_LENGTH);
        return key;
    }

    private static byte[] hmac(byte[] key, byte[] data) {
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(new SecretKeySpec(key, HMAC));
            return mac.doFinal(data);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] fromHex(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    static String toHex(byte[] bytes) {
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            hex.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xF, 16)));
            hex.append(Character.toUpperCase(Character.forDigit(b & 0xF, 16)));
        }
        return hex.toString();
    }

    /** Command-line entry for the node test: scheme, uidHex, saltHex, labelPrefix or infoHex, sectors. */
    public static void main(String[] args) {
        byte[] uid = fromHex(args[1]);
        byte[] salt = fromHex(args[2]);
        int sectors = Integer.parseInt(args[4]);
        byte[][] keys = "hmac-sha256-sector".equals(args[0])
                ? hmacSha256Sector(uid, salt, args[3], sectors)
                : hkdfSha256Sectors(uid, salt, fromHex(args[3]), sectors);
        for (byte[] key : keys) {
            System.out.println(toHex(key));
        }
    }
}
