"""
QR Code generator library (Python) - Standalone, zero-dependency.
Adapted from Project Nayuki (MIT License) - https://www.nayuki.io/page/qr-code-generator-library
"""
import itertools
from typing import List, Optional, Sequence, Tuple

class QrCode:
    # Error correction levels
    ECC_LOW = 0
    ECC_MEDIUM = 1
    ECC_QUARTILE = 2
    ECC_HIGH = 3

    # Format bits
    _FORMAT_BITS = [
        [0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976],
        [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0],
        [0x355F, 0x3068, 0x3F31, 0x3A06, 0x24B4, 0x2183, 0x2EDA, 0x2BED],
        [0x1689, 0x13BE, 0x1CE7, 0x19D0, 0x0762, 0x0255, 0x0D0C, 0x083B],
    ]

    _NUM_ERROR_CORRECTION_BLOCKS = [
        [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],  # Low
        [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],  # Medium
        [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],  # Quartile
        [0, 1, 1, 2, 4, 4, 4, 7, 8, 8, 11], # High
    ]

    _ECC_CODEWORDS_PER_BLOCK = [
        [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],  # Low
        [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], # Medium
        [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24], # Quartile
        [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28], # High
    ]

    _ALIGNMENT_PATTERN_BASE = [
        [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
    ]

    @classmethod
    def encode_text(cls, text: str, ecl: int = 1) -> 'QrCode':
        data_bytes = text.encode("utf-8")
        bit_buf = []

        # Find smallest version (1..10) that fits
        target_version = None
        for v in range(1, 11):
            cap = cls._get_capacity_bytes(v, ecl)
            # Mode (4 bits) + Count (8 or 16 bits) + data bits
            char_count_bits = 8 if v < 10 else 16
            if len(data_bytes) * 8 + 4 + char_count_bits <= cap * 8:
                target_version = v
                break

        if target_version is None:
            target_version = 10

        # Mode: Byte (0100)
        cls._append_bits(4, 4, bit_buf)
        # Character count indicator
        cls._append_bits(len(data_bytes), 8 if target_version < 10 else 16, bit_buf)
        # Data bytes
        for b in data_bytes:
            cls._append_bits(b, 8, bit_buf)

        # Terminator and padding
        cap_bits = cls._get_capacity_bytes(target_version, ecl) * 8
        terminator_len = min(4, cap_bits - len(bit_buf))
        cls._append_bits(0, terminator_len, bit_buf)

        # Pad to byte boundary
        while len(bit_buf) % 8 != 0:
            bit_buf.append(0)

        # Pad bytes 0xEC, 0x11
        pad_bytes = [0xEC, 0x11]
        pad_idx = 0
        while len(bit_buf) < cap_bits:
            cls._append_bits(pad_bytes[pad_idx], 8, bit_buf)
            pad_idx = 1 - pad_idx

        # Convert bit_buf to data codewords
        data_codewords = []
        for i in range(0, len(bit_buf), 8):
            val = 0
            for j in range(8):
                val = (val << 1) | bit_buf[i + j]
            data_codewords.append(val)

        return cls._create_qr(target_version, ecl, data_codewords)

    @classmethod
    def _get_capacity_bytes(cls, version: int, ecl: int) -> int:
        num_blocks = cls._NUM_ERROR_CORRECTION_BLOCKS[ecl][version]
        block_ecc_len = cls._ECC_CODEWORDS_PER_BLOCK[ecl][version]
        total_raw_codewords = cls._get_raw_codewords(version)
        return total_raw_codewords - (num_blocks * block_ecc_len)

    @classmethod
    def _get_raw_codewords(cls, version: int) -> int:
        raw_table = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
        return raw_table[version]

    @staticmethod
    def _append_bits(val: int, length: int, bit_buf: list):
        for i in range(length - 1, -1, -1):
            bit_buf.append((val >> i) & 1)

    @classmethod
    def _create_qr(cls, version: int, ecl: int, data_codewords: List[int]) -> 'QrCode':
        size = version * 4 + 17
        modules = [[False for _ in range(size)] for _ in range(size)]
        is_function = [[False for _ in range(size)] for _ in range(size)]

        # 1. Finder patterns
        cls._draw_finder(0, 0, modules, is_function, size)
        cls._draw_finder(size - 7, 0, modules, is_function, size)
        cls._draw_finder(0, size - 7, modules, is_function, size)

        # 2. Alignment patterns
        align_coords = cls._ALIGNMENT_PATTERN_BASE[version]
        for r in align_coords:
            for c in align_coords:
                if not (r <= 8 and c <= 8) and not (r <= 8 and c >= size - 8) and not (r >= size - 8 and c <= 8):
                    cls._draw_alignment(r, c, modules, is_function)

        # 3. Timing patterns
        for i in range(8, size - 8):
            modules[6][i] = (i % 2 == 0)
            is_function[6][i] = True
            modules[i][6] = (i % 2 == 0)
            is_function[i][6] = True

        # Dark module
        modules[size - 8][8] = True
        is_function[size - 8][8] = True

        # Reserve format info areas
        for i in range(9):
            if i != 6:
                is_function[8][i] = True
                is_function[i][8] = True
        for i in range(8):
            is_function[8][size - 1 - i] = True
            is_function[size - 1 - i][8] = True

        # 4. Error correction & interleaving
        all_codewords = cls._interleave_codewords(version, ecl, data_codewords)

        # 5. Place data bits into matrix
        cls._place_data_bits(all_codewords, size, modules, is_function)

        # 6. Apply optimal mask (0..7)
        best_mask = 0
        min_penalty = 10000000
        for mask in range(8):
            cls._apply_format_and_mask(mask, ecl, size, modules, is_function)
            penalty = cls._calc_penalty(size, modules)
            if penalty < min_penalty:
                min_penalty = penalty
                best_mask = mask
            # Unapply
            cls._apply_format_and_mask(mask, ecl, size, modules, is_function)

        # Apply winning mask
        cls._apply_format_and_mask(best_mask, ecl, size, modules, is_function)

        qr = QrCode()
        qr.size = size
        qr.modules = modules
        return qr

    @classmethod
    def _draw_finder(cls, start_r, start_c, modules, is_function, size):
        for r in range(-1, 8):
            for c in range(-1, 8):
                qr_r, qr_c = start_r + r, start_c + c
                if 0 <= qr_r < size and 0 <= qr_c < size:
                    is_black = (0 <= r <= 6 and (c in (0, 6) or r in (0, 6))) or (2 <= r <= 4 and 2 <= c <= 4)
                    modules[qr_r][qr_c] = is_black
                    is_function[qr_r][qr_c] = True

    @classmethod
    def _draw_alignment(cls, center_r, center_c, modules, is_function):
        for r in range(-2, 3):
            for c in range(-2, 3):
                is_black = (max(abs(r), abs(c)) in (0, 2))
                modules[center_r + r][center_c + c] = is_black
                is_function[center_r + r][center_c + c] = True

    @classmethod
    def _interleave_codewords(cls, version: int, ecl: int, data_codewords: List[int]) -> List[int]:
        num_blocks = cls._NUM_ERROR_CORRECTION_BLOCKS[ecl][version]
        block_ecc_len = cls._ECC_CODEWORDS_PER_BLOCK[ecl][version]
        total_data = len(data_codewords)
        base_short_len = total_data // num_blocks
        num_long_blocks = total_data % num_blocks

        data_blocks = []
        ecc_blocks = []
        idx = 0
        for i in range(num_blocks):
            block_len = base_short_len + (1 if i >= num_blocks - num_long_blocks else 0)
            d_blk = data_codewords[idx:idx + block_len]
            idx += block_len
            data_blocks.append(d_blk)
            ecc_blocks.append(cls._calc_ecc(d_blk, block_ecc_len))

        interleaved = []
        # Interleave data
        max_d_len = max(len(b) for b in data_blocks)
        for i in range(max_d_len):
            for b in data_blocks:
                if i < len(b):
                    interleaved.append(b[i])

        # Interleave ECC
        for i in range(block_ecc_len):
            for b in ecc_blocks:
                interleaved.append(b[i])

        return interleaved

    @classmethod
    def _calc_ecc(cls, data: List[int], ecc_len: int) -> List[int]:
        gen = cls._reed_solomon_generator(ecc_len)
        res = [0] * ecc_len
        for b in data:
            factor = b ^ res.pop(0)
            res.append(0)
            for j in range(ecc_len):
                res[j] ^= cls._gf_mul(gen[j], factor)
        return res

    @classmethod
    def _reed_solomon_generator(cls, degree: int) -> List[int]:
        poly = [1]
        for i in range(degree):
            root = cls._gf_exp(i)
            new_poly = [0] * (len(poly) + 1)
            for j in range(len(poly)):
                new_poly[j] ^= cls._gf_mul(poly[j], root)
                new_poly[j + 1] ^= poly[j]
            poly = new_poly
        return poly[:-1]

    @classmethod
    def _gf_mul(cls, x: int, y: int) -> int:
        if x == 0 or y == 0:
            return 0
        return cls._gf_exp((cls._gf_log(x) + cls._gf_log(y)) % 255)

    @classmethod
    def _gf_exp(cls, power: int) -> int:
        # Precalculated GF(256) power table with poly 0x11D
        val = 1
        for _ in range(power % 255):
            val = (val << 1) ^ (0x11D if val >= 128 else 0)
        return val

    @classmethod
    def _gf_log(cls, val: int) -> int:
        cur = 1
        for p in range(255):
            if cur == val:
                return p
            cur = (cur << 1) ^ (0x11D if cur >= 128 else 0)
        return 0

    @classmethod
    def _place_data_bits(cls, codewords: List[int], size: int, modules: list, is_function: list):
        bit_idx = 0
        total_bits = len(codewords) * 8
        c = size - 1
        upward = True

        while c > 0:
            if c == 6:
                c -= 1
            rows = range(size - 1, -1, -1) if upward else range(size)
            for r in rows:
                for col in (c, c - 1):
                    if not is_function[r][col]:
                        bit = (codewords[bit_idx >> 3] >> (7 - (bit_idx & 7))) & 1 if bit_idx < total_bits else 0
                        modules[r][col] = bool(bit)
                        bit_idx += 1
            upward = not upward
            c -= 2

    @classmethod
    def _apply_format_and_mask(cls, mask_idx: int, ecl: int, size: int, modules: list, is_function: list):
        # 1. Flip data bits using mask
        for r in range(size):
            for c in range(size):
                if not is_function[r][c]:
                    flip = False
                    if mask_idx == 0: flip = (r + c) % 2 == 0
                    elif mask_idx == 1: flip = r % 2 == 0
                    elif mask_idx == 2: flip = c % 3 == 0
                    elif mask_idx == 3: flip = (r + c) % 3 == 0
                    elif mask_idx == 4: flip = (r // 2 + c // 3) % 2 == 0
                    elif mask_idx == 5: flip = (r * c) % 2 + (r * c) % 3 == 0
                    elif mask_idx == 6: flip = ((r * c) % 2 + (r * c) % 3) % 2 == 0
                    elif mask_idx == 7: flip = ((r + c) % 2 + (r * c) % 3) % 2 == 0
                    if flip:
                        modules[r][c] = not modules[r][c]

        # 2. Draw format bits
        format_bits = cls._FORMAT_BITS[ecl][mask_idx]
        for i in range(15):
            bit = (format_bits >> i) & 1
            # Top-left
            if i < 6:
                modules[8][i] = bool(bit)
            elif i < 8:
                modules[8][i + 1] = bool(bit)
            elif i == 8:
                modules[7][8] = bool(bit)
            else:
                modules[14 - i][8] = bool(bit)

            # Bottom-left & Top-right
            if i < 8:
                modules[size - 1 - i][8] = bool(bit)
            else:
                modules[8][size - 15 + i] = bool(bit)

    @classmethod
    def _calc_penalty(cls, size: int, modules: list) -> int:
        penalty = 0
        # Horizontal & vertical runs
        for r in range(size):
            run_color = False
            run_len = 0
            for c in range(size):
                if modules[r][c] == run_color:
                    run_len += 1
                else:
                    if run_len >= 5: penalty += 3 + (run_len - 5)
                    run_color = modules[r][c]
                    run_len = 1
            if run_len >= 5: penalty += 3 + (run_len - 5)

        for c in range(size):
            run_color = False
            run_len = 0
            for r in range(size):
                if modules[r][c] == run_color:
                    run_len += 1
                else:
                    if run_len >= 5: penalty += 3 + (run_len - 5)
                    run_color = modules[r][c]
                    run_len = 1
            if run_len >= 5: penalty += 3 + (run_len - 5)

        return penalty

    def to_svg_str(self, border: int = 2) -> str:
        """Returns crisp SVG string of the QR code."""
        dim = self.size + border * 2
        rects = []
        for r in range(self.size):
            for c in range(self.size):
                if self.modules[r][c]:
                    rects.append(f'<rect x="{c + border}" y="{r + border}" width="1" height="1" fill="#0f172a"/>')

        rect_str = "".join(rects)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" width="100%" height="100%" shape-rendering="crispEdges">'
            f'<rect width="{dim}" height="{dim}" fill="#ffffff"/>'
            f'{rect_str}'
            f'</svg>'
        )
