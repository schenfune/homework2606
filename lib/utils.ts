import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// 合并条件className，并解决Tailwind类名冲突。
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
