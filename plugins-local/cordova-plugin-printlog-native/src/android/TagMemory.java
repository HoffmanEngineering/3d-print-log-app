package com.hoffmanengineering.printlog;

/**
 * Command-line entry for test/tag_memory.test.js. The memory classes themselves are ClassicDump
 * and PageDump; plain Java with no Android imports, so the test can compile them with javac.
 *
 * classic sectors putCsv unreadableCsv: puts sector s filled with byte s+1 for each s in
 *   putCsv, marks each sector in unreadableCsv, then prints "length N", "unreadable a,b,c" and
 *   "first-bytes" with the first byte of every sector as two hex digits.
 * page maxBytes chunkSize chunks: adds chunks of chunkSize bytes (chunk i filled with i+1) and
 *   prints the add results as "true,true,false" then "length N".
 */
final class TagMemory {
    private TagMemory() {
    }

    public static void main(String[] args) {
        if ("classic".equals(args[0])) {
            classic(Integer.parseInt(args[1]), ints(args[2]), ints(args[3]));
        } else if ("page".equals(args[0])) {
            page(Integer.parseInt(args[1]), Integer.parseInt(args[2]), Integer.parseInt(args[3]));
        } else {
            throw new IllegalArgumentException(args[0]);
        }
    }

    private static void classic(int sectors, int[] put, int[] unreadable) {
        ClassicDump dump = new ClassicDump(sectors);
        for (int s : put) {
            byte[] data = new byte[ClassicDump.SECTOR_BYTES];
            java.util.Arrays.fill(data, (byte) (s + 1));
            dump.putSector(s, data);
        }
        for (int s : unreadable) {
            dump.markUnreadable(s);
        }
        byte[] bytes = dump.bytes();
        System.out.println("length " + bytes.length);
        StringBuilder marked = new StringBuilder();
        for (int s : dump.unreadable()) {
            marked.append(marked.length() == 0 ? "" : ",").append(s);
        }
        System.out.println("unreadable " + marked);
        StringBuilder first = new StringBuilder();
        for (int s = 0; s < sectors; s++) {
            first.append(first.length() == 0 ? "" : ",")
                    .append(TagKeySchemes.toHex(new byte[] {bytes[s * ClassicDump.SECTOR_BYTES]}));
        }
        System.out.println("first-bytes " + first);
    }

    private static void page(int maxBytes, int chunkSize, int chunks) {
        PageDump dump = new PageDump(maxBytes);
        StringBuilder results = new StringBuilder();
        for (int i = 0; i < chunks; i++) {
            byte[] chunk = new byte[chunkSize];
            java.util.Arrays.fill(chunk, (byte) (i + 1));
            results.append(i == 0 ? "" : ",").append(dump.add(chunk));
        }
        System.out.println(results);
        System.out.println("length " + dump.bytes().length);
    }

    private static int[] ints(String csv) {
        if (csv.isEmpty()) {
            return new int[0];
        }
        String[] parts = csv.split(",");
        int[] out = new int[parts.length];
        for (int i = 0; i < out.length; i++) {
            out[i] = Integer.parseInt(parts[i]);
        }
        return out;
    }
}
