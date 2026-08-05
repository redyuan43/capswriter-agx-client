import React from "react";
import FloatingBallApp from "./features/recording/FloatingBallApp.jsx";
import appLogoUrl from "../assets/icon.png?url";

const SettingsPage = React.lazy(() =>
  import("./settings.jsx").then((module) => ({ default: module.SettingsPage }))
);

function shouldRenderSettingsPage(search) {
  const urlParams = new URLSearchParams(search);
  const page = (urlParams.get("page") || "").toLowerCase();
  const panel = (urlParams.get("panel") || "").toLowerCase();
  return page === "settings" || panel === "control";
}

function LoadingLogo({ label }) {
  return (
    <div className="loading loading-with-logo">
      <img className="loading-logo" src={appLogoUrl} alt="" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export default function App() {
  if (shouldRenderSettingsPage(window.location.search)) {
    return (
      <React.Suspense fallback={<LoadingLogo label="加载设置页面..." />}>
        <SettingsPage />
      </React.Suspense>
    );
  }

  return <FloatingBallApp />;
}
