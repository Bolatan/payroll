import { useState } from "react";

const heroImage =
  "https://images.pexels.com/photos/37405043/pexels-photo-37405043.jpeg?auto=compress&cs=tinysrgb&h=650&w=940";

const galleryImages = [
  {
    src: "https://images.pexels.com/photos/34906872/pexels-photo-34906872.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
    alt: "Vibrant market stall with clothing and shoes on display",
    caption: "Markets full of colour",
  },
  {
    src: "https://images.pexels.com/photos/39916892/pexels-photo-39916892.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
    alt: "Man smiling at a fabric market with bold patterns",
    caption: "Fabrics with stories",
  },
  {
    src: "https://images.pexels.com/photos/22681398/pexels-photo-22681398.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
    alt: "Carter Bridge spanning calm water in Lagos",
    caption: "Bridges over the lagoon",
  },
  {
    src: "https://images.pexels.com/photos/38519894/pexels-photo-38519894.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
    alt: "Woman in traditional attire at an African market",
    caption: "Everyday elegance",
  },
];

const highlights = [
  {
    title: "Island rhythm",
    text: "From Lekki to Victoria Island, the city moves to a beat you can feel in every street.",
  },
  {
    title: "Flavour on every corner",
    text: "Jollof, suya and fresh pepper soup are part of daily life, shared with friends and strangers alike.",
  },
  {
    title: "Sunsets on the water",
    text: "Lagoon breezes and golden evenings make the city's waterfront a favourite place to unwind.",
  },
];

const navLinks = [
  { href: "#about", label: "About" },
  { href: "#gallery", label: "Gallery" },
  { href: "#visit", label: "Visit" },
];

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="page">
      <header className="site-header">
        <a href="#top" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Lagos
        </a>
        <button
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="site-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          Menu
        </button>
        <nav id="site-nav" className={`site-nav${menuOpen ? " is-open" : ""}`}>
          {navLinks.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
              {link.label}
            </a>
          ))}
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Eko o ni baje o</p>
            <h1>The city that never stops moving</h1>
            <p className="lede">
              Discover the energy, colour and warmth of Lagos, Nigeria's bustling coastal megacity.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#visit">
                Plan your visit
              </a>
              <a className="button button-ghost" href="#gallery">
                See the gallery
              </a>
            </div>
          </div>
          <div className="hero-media">
            <img src={heroImage} alt="Skyline of Lagos over the lagoon" />
          </div>
        </section>

        <section id="about" className="section">
          <header className="section-heading">
            <p className="eyebrow">About the city</p>
            <h2>Where the lagoon meets ambition</h2>
          </header>
          <div className="card-grid">
            {highlights.map((item) => (
              <article key={item.title} className="card">
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="gallery" className="section section-tinted">
          <header className="section-heading">
            <p className="eyebrow">Gallery</p>
            <h2>Colour in every corner</h2>
          </header>
          <div className="gallery-grid">
            {galleryImages.map((image) => (
              <figure key={image.src} className="gallery-item">
                <img src={image.src} alt={image.alt} loading="lazy" />
                <figcaption>{image.caption}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section id="visit" className="section cta">
          <h2>Ready to experience Lagos?</h2>
          <p>Bring your curiosity, an appetite for adventure, and a little extra time for the traffic.</p>
          <a className="button button-primary" href="mailto:hello@example.com">
            Get in touch
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <p>Lagos, Nigeria. Made with pride on the lagoon.</p>
      </footer>
    </div>
  );
}
