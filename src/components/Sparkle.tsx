import LottieView from "lottie-react-native";

/**
 * 金色火花 · Lottie 点缀。
 * 素材是手写的（assets/lottie/*.json），不依赖外部图库，配色与主题一致。
 */

export function SparkleLoop({ size = 34, opacity = 1 }: { size?: number; opacity?: number }) {
  return (
    <LottieView
      source={require("../../assets/lottie/sparkle-loop.json")}
      autoPlay
      loop
      style={{ width: size, height: size, opacity }}
    />
  );
}

/** 一次性爆闪：结算卡 / 升级时用 */
export function SparkleBurst({ size = 240, opacity = 1 }: { size?: number; opacity?: number }) {
  return (
    <LottieView
      source={require("../../assets/lottie/sparkle-burst.json")}
      autoPlay
      loop={false}
      style={{ width: size, height: size, opacity }}
    />
  );
}
