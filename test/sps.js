'use strict';
// 生成合成 H.264 SPS（NAL type=7）喂给 parseSpsToDims。
// 测真实 SPS 字节流需要先有编码器；这里用 bit-writer 精确构造，
// 覆盖脚本实际处理的分支：Baseline 简化路径、High profile 扩展路径、frame_cropping。
function BitWriter() { this.bits = []; }
BitWriter.prototype.u = function (n, v) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v >>> i) & 1);
    return this;
};
// ue(v)：codeNum = v+1 的二进制共 L 位 → L-1 个前导 0 + 完整 L 位
// 例：ue(0)→'1'；ue(1)→'010'；ue(79)→80=1010000→'000000'+'1010000'
BitWriter.prototype.ue = function (v) {
    const code = v + 1;
    let L = 0;
    for (let t = code; t > 0; t >>= 1) L++;
    this.u(L - 1, 0);
    this.u(L, code);
    return this;
};
// se(v)：映射到 ue —— 偶数 v→ue(-2v)，奇数 v→ue(2v-1)
BitWriter.prototype.se = function (v) {
    return this.ue(v <= 0 ? -2 * v : 2 * v - 1);
};
BitWriter.prototype.bytes = function () {
    while (this.bits.length % 8 !== 0) this.bits.push(0);   // 补齐字节
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
        out.push(b);
    }
    return Uint8Array.from(out);
};

// profile 66(Baseline)/77(Main) 不读 chroma 扩展块；profile 100(High) 等要读
const EXTENDED_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/**
 * @param widthMbs   以 macroblock 为单位的宽（1280 → 80）
 * @param heightMbs  以 macroblock 为单位的高（720 → 45）
 * @param profile    profile_idc（66/77 简化路径，100 走扩展路径）
 * @param level      level_idc（30=3.0, 31=3.1, 40=4.0 …）
 * @param crop       [left,right,top,bottom] 以 crop unit 计；null = 不写 frame_cropping
 * @param frameMbsOnly 1=逐帧（高度直接是 map units），0=含 MBAFF（高度需 ×2）
 */
function makeSps(widthMbs, heightMbs, profile, level, crop, frameMbsOnly) {
    if (frameMbsOnly === undefined) frameMbsOnly = 1;
    const w = new BitWriter();
    w.u(8, 0x67);                 // NAL header: nal_ref_idc=3, type=7 (SPS)
    w.u(8, profile);
    w.u(8, 0);                    // constraint flags + reserved
    w.u(8, level);
    w.ue(0);                      // seq_parameter_set_id
    if (EXTENDED_PROFILES.indexOf(profile) >= 0) {
        w.ue(1);                  // chroma_format_idc = 4:2:0
        w.ue(0);                  // bit_depth_luma_minus8
        w.ue(0);                  // bit_depth_chroma_minus8
        w.u(1, 0);                // qpprime_y_zero_transform_bypass_flag
        w.u(1, 0);                // seq_scaling_matrix_present_flag
    }
    w.ue(0);                      // log2_max_frame_num_minus4
    w.ue(0);                      // pic_order_cnt_type = 0
    w.ue(0);                      // log2_max_pic_order_cnt_lsb_minus4
    w.ue(1);                      // max_num_ref_frames
    w.u(1, 0);                    // gaps_in_frame_num_value_allowed_flag
    w.ue(widthMbs - 1);           // pic_width_in_mbs_minus1
    w.ue(heightMbs - 1);          // pic_height_in_map_units_minus1
    w.u(1, frameMbsOnly);         // frame_mbs_only_flag
    if (!frameMbsOnly) w.u(1, 0); // mb_adaptive_frame_field_flag
    w.u(1, 1);                    // direct_8x8_inference_flag
    if (crop) {
        w.u(1, 1);                // frame_cropping_flag
        w.ue(crop[0]); w.ue(crop[1]); w.ue(crop[2]); w.ue(crop[3]);
    } else {
        w.u(1, 0);                // frame_cropping_flag = 0
    }
    w.u(1, 0);                    // vui_parameters_present_flag
    w.u(1, 1);                    // rbsp_stop_one_bit
    return w.bytes();
}

module.exports = { makeSps };