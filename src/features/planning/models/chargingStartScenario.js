// 用户提供的 v0.1 情景，逐小时单位为百分比；不是本地订单或论文原始数据。
export const CHARGING_START_PERCENT = {
  residential:{weekday:[2,1,1,1,1,1,1,2,3,3,3,3,4,3,3,3,4,6,9,11,11,10,8,6],weekend:[2,1,1,1,1,1,1,1,2,2,3,4,5,5,5,5,5,6,8,10,10,9,7,5]},
  work:{weekday:[1,0,0,0,0,0,1,4,12,13,8,8,8,8,8,8,7,5,3,2,1,1,1,1],weekend:[1,0,0,0,0,0,1,2,5,7,8,8,10,9,9,9,8,7,5,4,3,2,1,1]},
  shopping:{weekday:[0,0,0,0,0,0,0,0,1,2,4,7,9,10,10,9,7,7,8,8,6,5,4,3],weekend:[0,0,0,0,0,0,0,0,1,2,4,7,10,11,11,10,8,8,8,7,5,4,3,1]},
  leisure:{weekday:[0,0,0,0,0,0,0,0,1,2,3,5,7,8,9,9,9,9,10,9,7,5,4,3],weekend:[0,0,0,0,0,0,0,0,1,2,4,6,8,10,10,10,9,9,9,8,5,4,3,2]},
  public:{weekday:[2,1,1,1,1,2,3,5,7,8,7,7,6,6,7,7,7,6,5,4,3,2,1,1],weekend:[2,1,1,1,1,2,3,4,5,7,7,7,8,7,7,7,7,7,5,4,3,2,1,1]},
}
export const PUBLIC_CHARGING_Q = {
  low:{residential:.6,work:.6,shopping:.8,leisure:.6,public:.7},
  medium:{residential:.8,work:.9,shopping:1.1,leisure:.9,public:1},
  high:{residential:1.1,work:1.2,shopping:1.5,leisure:1.2,public:1.3},
}
export const ACTIVITY_WEIGHT = .2
