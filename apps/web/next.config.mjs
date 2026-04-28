/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static HTML export to out/. CloudFront serves these files directly from
  // the S3 origin bucket; no SSR runtime is involved.
  output: "export",

  // Image optimization API requires a server. Static export means we use
  // unoptimized images; build-time optimization happens elsewhere if needed.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
