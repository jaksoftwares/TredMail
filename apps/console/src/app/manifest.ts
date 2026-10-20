import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TredMail by Dovepeak Technologies",
    short_name: "TredMail",
    description: "Transactional email for your applications, by Dovepeak Technologies.",
    start_url: "/overview",
    display: "standalone",
    background_color: "#f8f8ff",
    theme_color: "#000027",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
