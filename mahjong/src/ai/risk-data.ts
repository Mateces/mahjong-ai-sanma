// Risk evaluation lookup tables ported from mahjong-helper/util/risk_data.go

export const RiskTileType = {
	NoSuji5: 0,
	NoSuji46: 1,
	NoSuji37: 2,
	NoSuji28: 3,
	NoSuji19: 4,
	HalfSuji5: 5,
	HalfSuji46A: 6,
	HalfSuji46B: 7,
	Suji37: 8,
	Suji28: 9,
	Suji19: 10,
	DoubleSuji5: 11,
	DoubleSuji46: 12,
	YakuHaiLeft3: 13,
	YakuHaiLeft2: 14,
	YakuHaiLeft1: 15,
	OtakazeLeft3: 16,
	OtakazeLeft2: 17,
	OtakazeLeft1: 18,
} as const

// [巡目][牌类型] 铳率 (%)
// 巡目 0 为空, 1-18 有数据, 19 为最终数据
export const RiskRate: number[][] = [
	[],
	[5.7, 5.7, 5.8, 4.7, 3.4, 2.5, 2.5, 3.1, 5.6, 3.8, 1.8, 0.8, 2.6, 2.1, 1.2, 0.5, 2.4, 1.4, 1.2],
	[6.6, 6.9, 6.3, 5.2, 4.0, 3.5, 3.5, 4.1, 5.3, 3.5, 1.9, 0.8, 2.6, 2.3, 1.2, 0.5, 2.7, 1.3, 0.4],
	[7.7, 8.0, 6.7, 5.8, 4.6, 4.3, 4.1, 4.9, 5.2, 3.6, 1.8, 1.6, 2.0, 2.4, 1.2, 0.3, 2.6, 1.2, 0.3],
	[8.5, 8.9, 7.1, 6.2, 5.1, 4.8, 4.7, 5.6, 5.2, 3.8, 1.7, 1.6, 2.0, 2.6, 1.1, 0.2, 2.6, 1.2, 0.2],
	[9.4, 9.7, 7.5, 6.7, 5.5, 5.3, 5.1, 6.0, 5.3, 3.7, 1.7, 1.7, 2.0, 2.9, 1.2, 0.2, 2.8, 1.2, 0.2],
	[10.2, 10.5, 7.9, 7.1, 5.9, 5.8, 5.6, 6.4, 5.2, 3.7, 1.7, 1.8, 2.0, 3.2, 1.3, 0.2, 2.9, 1.3, 0.2],
	[11.0, 11.3, 8.4, 7.5, 6.3, 6.3, 6.1, 6.8, 5.3, 3.7, 1.7, 2.0, 2.1, 3.6, 1.4, 0.2, 3.2, 1.4, 0.2],
	[11.9, 12.2, 8.9, 8.0, 6.8, 6.9, 6.6, 7.4, 5.3, 3.8, 1.7, 2.1, 2.2, 4.0, 1.6, 0.2, 3.5, 1.6, 0.2],
	[12.8, 13.1, 9.5, 8.6, 7.4, 7.4, 7.2, 7.9, 5.5, 3.9, 1.8, 2.2, 2.3, 4.6, 1.9, 0.3, 4.0, 1.8, 0.2],
	[13.8, 14.1, 10.1, 9.2, 8.0, 8.0, 7.8, 8.5, 5.6, 4.0, 1.9, 2.4, 2.4, 5.3, 2.2, 0.3, 4.6, 2.1, 0.3],
	[14.9, 15.1, 10.8, 9.9, 8.7, 8.7, 8.5, 9.2, 5.7, 4.2, 2.0, 2.5, 2.6, 6.0, 2.6, 0.4, 5.1, 2.5, 0.3],
	[16.0, 16.3, 11.6, 10.6, 9.4, 9.4, 9.2, 9.9, 6.0, 4.4, 2.2, 2.7, 2.7, 6.8, 3.1, 0.4, 5.1, 2.5, 0.3],
	[17.2, 17.5, 12.4, 11.4, 10.2, 10.2, 10.0, 10.6, 6.2, 4.6, 2.4, 3.0, 3.0, 7.8, 3.7, 0.5, 6.6, 3.7, 0.5],
	[18.5, 18.8, 13.3, 12.3, 11.1, 11.0, 10.9, 11.4, 6.6, 4.9, 2.7, 3.2, 3.1, 8.8, 4.4, 0.7, 7.4, 4.4, 0.6],
	[19.9, 20.1, 14.3, 13.3, 12.0, 11.9, 11.8, 12.3, 7.0, 5.3, 3.0, 3.4, 3.4, 9.9, 5.2, 0.8, 8.4, 5.3, 0.8],
	[21.3, 21.7, 15.4, 14.3, 13.1, 12.9, 12.8, 13.3, 7.4, 5.7, 3.3, 3.7, 3.6, 11.2, 6.2, 1.0, 9.4, 6.5, 0.9],
	[22.9, 23.2, 16.6, 15.4, 14.2, 14.0, 13.8, 14.4, 8.0, 6.1, 3.6, 3.9, 3.9, 12.4, 7.3, 1.3, 10.5, 7.7, 1.2],
	[24.7, 24.9, 17.9, 16.7, 15.4, 15.2, 15.0, 15.6, 8.5, 6.6, 4.0, 4.3, 4.2, 13.9, 8.5, 1.7, 11.8, 9.4, 1.6],
	[27.5, 27.8, 20.4, 19.1, 17.8, 17.5, 17.5, 17.5, 9.8, 7.4, 5.0, 5.1, 5.1, 18.1, 12.1, 2.8, 14.7, 12.6, 2.1],
]

export const MaxTurns = RiskRate.length - 1

// 考虑失点的综合值（参考第9巡的数据）
export const FixedDoraRiskRateMulti: number[] = [
	14.9 / 12.8 * 78 / 58, // NoSuji5
	15.0 / 13.1 * 78 / 58, // NoSuji46
	12.1 / 9.5 * 75 / 56, // NoSuji37
	10.3 / 8.6 * 75 / 54, // NoSuji28
	8.9 / 7.4 * 77 / 53, // NoSuji19
	9.7 / 7.4 * 81 / 60, // HalfSuji5
	8.9 / 7.2 * 81 / 60, // HalfSuji46A
	10.4 / 7.9 * 81 / 60, // HalfSuji46B
	8.0 / 5.5 * 75 / 56, // Suji37
	5.5 / 3.9 * 81 / 56, // Suji28
	3.5 / 1.8 * 92 / 58, // Suji19
	4.1 / 2.2 * 88 / 62, // DoubleSuji5
	4.1 / 2.3 * 88 / 62, // DoubleSuji46
	5.2 / 4.6 * 96 / 67, // YakuHaiLeft3
	2.9 / 1.9 * 96 / 67, // YakuHaiLeft2
	1.1 / 0.3 * 96 / 67, // YakuHaiLeft1
	5.1 / 4.0 * 92 / 56, // OtakazeLeft3
	3.0 / 1.8 * 92 / 56, // OtakazeLeft2
	0.8 / 0.2 * 92 / 56, // OtakazeLeft1
]

// [牌的rank(0-8)][安牌状态] → 对应的牌类型
// 123789: 2种 (无筋/筋)
// 456: 4种 (无筋/半筋A/半筋B/双筋)
export const TileTypeTable: number[][] = [
	[RiskTileType.NoSuji19, RiskTileType.Suji19],
	[RiskTileType.NoSuji28, RiskTileType.Suji28],
	[RiskTileType.NoSuji37, RiskTileType.Suji37],
	[RiskTileType.NoSuji46, RiskTileType.HalfSuji46B, RiskTileType.HalfSuji46A, RiskTileType.DoubleSuji46],
	[RiskTileType.NoSuji5, RiskTileType.HalfSuji5, RiskTileType.HalfSuji5, RiskTileType.DoubleSuji5],
	[RiskTileType.NoSuji46, RiskTileType.HalfSuji46A, RiskTileType.HalfSuji46B, RiskTileType.DoubleSuji46],
	[RiskTileType.NoSuji37, RiskTileType.Suji37],
	[RiskTileType.NoSuji28, RiskTileType.Suji28],
	[RiskTileType.NoSuji19, RiskTileType.Suji19],
]

// [是否为役牌(0-1)][剩余数-1]
export const HonorTileType: number[][] = [
	[RiskTileType.OtakazeLeft1, RiskTileType.OtakazeLeft2, RiskTileType.OtakazeLeft3, RiskTileType.OtakazeLeft3],
	[RiskTileType.YakuHaiLeft1, RiskTileType.YakuHaiLeft2, RiskTileType.YakuHaiLeft3, RiskTileType.YakuHaiLeft3],
]
