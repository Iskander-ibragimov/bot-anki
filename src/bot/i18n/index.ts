import type { Lang } from "../../srs/fsrs";
import { en } from "./en";
import { ru, type Dict } from "./ru";

export const dict = (lang: Lang): Dict => (lang === "ru" ? ru : en);
export type { Dict };
