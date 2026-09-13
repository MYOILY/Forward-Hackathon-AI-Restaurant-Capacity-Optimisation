const logoUrl = new URL("./assets/turntable-logo.png", import.meta.url).href;

export function BrandLogo() {
  return (
    <img
      className="brand-logo"
      src={logoUrl}
      alt="TurnTable"
      width={1348}
      height={539}
    />
  );
}
