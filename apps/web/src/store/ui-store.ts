"use client";

import { create } from "zustand";

type UiState = {
  mobileNavigationOpen: boolean;
  setMobileNavigationOpen: (open: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  mobileNavigationOpen: false,
  setMobileNavigationOpen: (mobileNavigationOpen) =>
    set({ mobileNavigationOpen }),
}));
