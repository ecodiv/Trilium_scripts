/**
 * cv-seed — one-off backend script that creates the CV subtree used by
 * cv-builder.jsx, pre-filled with Paulo van Breugel's CV content.
 *
 * Usage: create a code note of type "JS backend" where you want the CV tree,
 * paste this file in and click "Execute" (or Ctrl+Enter). The tree is created
 * as a sibling of this script note. The script refuses to run when a note with
 * #cvRoot already exists, so it cannot create a duplicate tree. Delete the
 * script note afterwards if you like; the CV tree does not depend on it.
 *
 * Inline markup in the data below uses markdown links/bold/italic; md() turns it
 * into the HTML stored in Trilium text notes.
 */

const SEED = {
  profile: {
    labels: {
      name: "Paulo van Breugel",
      headline: "Senior lecturer-researcher",
      location: "'s-Hertogenbosch, NL",
      phone: "+31 6121 89147",
      email: "p.vanbreugel@has.nl",
      github: "ecodiv",
      linkedin: "paulo-van-breugel",
    },
    links: [
      "ecodiv.earth | https://ecodiv.earth | globe",
      "has.nl profile | https://www.has.nl/onderzoek/paulo-van-breugel/ | globe",
    ],
    body: [
      "I am passionate about helping students to combine domain-specific knowledge and geospatial analysis to address societal challenges. As a researcher, I hope to contribute to a better understanding of our natural environment and how this can help us to develop more sustainable and equitable environment management practices.",
    ],
  },

  sections: [
    {
      key: "experience", title: "Experience", nl: "Werkervaring", entryType: "experience", jsonResume: "work",
      entries: [
        { title: "Senior lecturer and researcher — HAS", cvId: "has-senior", position: "Senior lecturer and researcher", company: "HAS green academy", location: "'s-Hertogenbosch, NL", start: "2020", end: "present", tags: "teaching,research,geo",
          items: ["Teaching on topics related to geospatial datascience, remote sensing, ecology, biodiversity monitoring and research skills, supervising student projects", "Research groups ‘Climate Robust Landscapes’ and ‘Data Intelligence for Sustainable Transitions’ (since 2024)", "Member of the research and professional field advisory committee for the Applied Geo-information Science program (2020 - 2021)", "External courses and presentations"] },
        { title: "Lecturer and researcher — HAS", cvId: "has-lecturer", position: "Lecturer and researcher", company: "HAS green academy", location: "'s-Hertogenbosch, NL", start: "2017", end: "2020", tags: "teaching,research,geo",
          items: ["Teaching on topics related to geospatial datascience, R, ecology, statistics, research skills, and report writing, and supervising student projects", "Researcher in the ‘Innovative Bio‑Monitoring’ research group (since 2019, ongoing)", "Member of the HAS International Projects Working Group (2017 - 2019)"] },
        { title: "Consultant (2015-2017)", cvId: "consultant-2015", position: "Consultant", location: "Apeldoorn, NL", start: "2015", end: "2017", tags: "consultancy,international",
          items: ["Various research and development projects by the World Agroforestry Center, Copenhagen University, Tropical Agricultural Research and Higher Education Center (CATIE), Livestock Research Institute (ILRI) and International Water Management Institute (IWMI)"] },
        { title: "Ph.D. researcher — University of Copenhagen", cvId: "phd", position: "Ph.D. researcher", company: "University of Copenhagen", location: "Copenhagen, DK / Apeldoorn, NL", start: "2010", end: "2016", tags: "research,geo,international",
          items: ["Assessment of the influence of future climate changes and other major drivers on natural habitats in eastern Africa, combining historical data with spatial modeling", "In-field training of field assistants and the co-supervision of M.Sc. students"] },
        { title: "Consultant (2004-2010)", cvId: "consultant-2004", position: "Consultant", location: "Nairobi, Kenya", start: "2004", end: "2010", tags: "consultancy,geo,international",
          items: ["Vegetation and Climate Change in Eastern Africa (VECEA) project, International Livestock Research Institute (ILRI), Bioversity International, and Terre des Hommes Netherlands"] },
        { title: "Visiting scientist — Imazon", cvId: "imazon", position: "Visiting scientist", company: "Institute of Man and Environment in the Amazon (Imazon)", location: "Belem, Brazil", start: "2003", end: "2003", tags: "research,international",
          items: ["Project ‘Criteria and Indicators for Sustainable Forest Management’ with Imazon, Biodiversity International, and the Institute for Forest Management and Certification (Imaflora)"] },
        { title: "Visiting scientist — São Paulo University", cvId: "usp", position: "Visiting scientist", company: "São Paulo University", location: "Piracicaba, Brazil", start: "2002", end: "2003", tags: "research,international",
          items: ["Attachment at the University of São Paulo; training in the use of genetic markers to study population genetic structure of the tree species"] },
        { title: "Associate scientist — Bioversity, Americas", cvId: "bioversity-americas", position: "Associate scientist", company: "Bioversity International, Regional office for the Americas", location: "Piracicaba, Brazil", start: "2000", end: "2002", tags: "research,international",
          items: ["Liaison Officer for the Forest Genetic Resources Research Group in Latin America", "Researcher in the project ‘Challenges in Managing Forest Genetic Resources for Livelihoods’ in Brazil and Argentina"] },
        { title: "Associate scientist — Bioversity, CWANA", cvId: "bioversity-cwana", position: "Associate scientist", company: "Bioversity International, Regional Office for Central and West Asia and North Africa", location: "Aleppo, Syria", start: "1997", end: "2000", tags: "research,international",
          items: ["Focal point of the Forest Genetic Resources Program of Bioversity International in Central and West Asia and North Africa", "Development of a new pilot program on forest genetic resources in Syria and Lebanon"] },
      ],
    },
    {
      key: "extracurricular", title: "Extracurricular activities", nl: "Nevenactiviteiten", entryType: "experience", jsonResume: "projects",
      entries: [
        { title: "GRASS GIS addons and tutorials", cvId: "grass", company: "GRASS GIS addons and tutorials", position: "Creator and maintainer", tags: "geo",
          body: ["GRASS GIS addons and tutorials for e.g., species distribution modeling and the visualization of spatio-temporal patterns. See [ecodiv.earth](https://ecodiv.earth)."] },
        { title: "OSGeo.nl", cvId: "osgeo", company: "OSGeo.nl", position: "Treasurer", tags: "geo",
          body: ["Dutch chapter of the Open Source Geospatial Foundation (OSGeo). For more information, see [osgeo.nl](https://osgeo.nl)."] },
        { title: "Vegetationmap4africa.org", cvId: "vegmap", company: "Vegetationmap4africa.org", position: "Contributor", tags: "geo,research",
          body: ["Mapping the potential natural vegetation of eastern Africa. For more information, see the [vegetationmap4africa.org](https://vegetationmap4africa.org) website."] },
      ],
    },
    {
      key: "readers", title: "Readers", nl: "Lesmateriaal", entryType: "text", jsonResume: "publications",
      entries: [
        { title: "Een blik op metadata (2024)", year: "2024", tags: "teaching", body: ["de Visser, M., & van Breugel, P. (2024). Een blik op metadata. Samen aan de slag. Cursus voor Samen aan de slag dagen, 17-18 January 2024. HAS green academy. [https://edu.nl/k4emh](https://dilab-sb.has.nl/metadata/)"] },
        { title: "Introduction to remote sensing (2023)", year: "2023", tags: "teaching,geo", body: ["van Breugel, P., & Terlien, M. (2023). Introduction to remote sensing. HAS green academy, [https://edu.nl/7bdcr](https://dilab-sb.has.nl/lesmateriaal/remote_sensing)"] },
        { title: "Multicriteria decision analysis (2023)", year: "2024", tags: "teaching,geo", body: ["Breugel, P. van. (2023, last update: 2024). Multicriteria decision analysis (theory & exercises). HAS green academy, [https://edu.nl/ep7xq](https://dilab-sb.has.nl/lesmateriaal/reader_MCDA)"] },
        { title: "Species distribution modeling (2022)", year: "2024", tags: "teaching,geo", body: ["van Breugel, P. (2022, last update: 2024). Species distribution modeling. Theory and QGIS and ArcGIS exercises. HAS green academy, [https://edu.nl/q7c8m](https://dilab-sb.has.nl/lesmateriaal/reader_SDM)"] },
        { title: "Python in Data Driven Design (2021)", year: "2021", tags: "teaching", body: ["van Breugel, P., & Terlien, M. (2021). Python in Data Driven Design. HAS green academy, [https://edu.nl/wgxk3](https://github.com/HASUniversity/DDD_Python)"] },
      ],
    },
    {
      key: "publications", title: "Publications", nl: "Publicaties", entryType: "text", jsonResume: "publications",
      intro: ["For a complete list of publications, see my [Zotero profile](https://www.zotero.org/pvb-zotero/) or [ResearchGate](https://www.researchgate.net/profile/Paulo_Breugel)."],
      entries: [
        { title: "Save the tiger in the cloud (2024)", year: "2024", tags: "presentation,geo", body: ["van Breugel, P., & Bood, R. J. (2024, March 7). Save the tiger in the cloud [Presentation]. SURF Cloudevent 2024, Amersfoort, the Netherlands. [https://edu.nl/49phw](https://www.surf.nl/agenda/terugblik-surf-cloudevent-2024/terugblik-surf-cloudevent-2024)."] },
        { title: "Remote sensing & biodiversiteit (2022)", year: "2022", tags: "presentation,geo", body: ["van Breugel, P. (2022, May 17). Remote sensing & biodiversiteit [Presentation]. Meten is weten, biodiversiteit in beeld., Leiden [https://edu.nl/7q9x4](https://edu.nl/7q9x4)."] },
        { title: "Plants and vegetation of NW Ethiopia (2022)", year: "2022", tags: "book", body: ["Friis, I., Demissew, S., Weber, O., & van Breugel, P. (2022). Plants and vegetation of NW Ethiopia: A new look at Rodolfo E.G. Pichi Sermolli’s results from the ‘Missione di Studio al Lago Tana’, 1937 (1st ed., Vol. 240). Firenze University Press. [https://edu.nl/tfur9](https://edu.nl/tfur9)."] },
        { title: "The Western Woodlands of Ethiopia (2022)", year: "2022", tags: "book", body: ["Friis, I., Breugel, P. van, Weber, O., & Demissew, S. (2022). The Western Woodlands of Ethiopia. A study of the woody vegetation and flora between the highlands of Ethiopia and the lowlands of the Nile Valley in the Sudan and South Sudan. [https://edu.nl/mand3](https://gad.dk/the-western-woodlands-of-ethiopia)."] },
        { title: "The Gerire Hills — Anacampseros specksii (2019)", year: "2019", tags: "paper", url: "https://doi.org/10.1080/00837792.2019.1670020", body: ["Friis, I., Gilbert, M. G., Weber, O., Breugel, P. V., & Demissew, S. (2019). The Gerire Hills, SE Ethiopia: Ecology and phytogeographical position of an additional local endemic, Anacampseros specksii (Anacampserotaceae). Webbia, 74(2), 185-192. [https://edu.nl/7e3uf](https://doi.org/10.1080/00837792.2019.1670020)."] },
        { title: "Contributions of biodiversity to sustainable intensification (2019)", year: "2019", tags: "report", body: ["Dawson, I., Attwood, S., Park, S., Jamnadass, R., Powell, W., Sunderland, T., Kindt, R., McMullin, S., Hoebe, P., Baddeley, J., Staver, C., Vadez, V., Carsan, S., Roshetko, J., Amri, A., Karamura, E., Karamura, D., Breugel, P., Hossain, M., & Graudal, L. (2019). Contributions of biodiversity to the sustainable intensification of food production thematic study for the state of the world's biodiversity for food and agriculture. Food and Agriculture Organization of the United Nations (FAO). [https://edu.nl/tyfen](https://www.fao.org/publications/card/en/c/CA4003EN/)."] },
        { title: "Institutional environments for agroforestry seed systems (2018)", year: "2018", tags: "paper", url: "https://doi.org/10.1111/dpr.12233", body: ["Lillesø, J. p. b., Harwood, C., Derero, A., Graudal, L., Roshetko, J. m., Kindt, R., Moestrup, S., Omondi, W. O., Holtne, N., Mbora, A., van Breugel, P., Dawson, I. K., Jamnadass, R., & Egelyng, H. (2018). Why Institutional Environments for Agroforestry Seed Systems Matter. Development Policy Review, 36, 089-0112. [https://edu.nl/v63mb](https://doi.org/10.1111/dpr.12233)."] },
        { title: "The Gerire Hills — semi-evergreen bushland (2018)", year: "2018", tags: "paper", url: "https://doi.org/10.1080/00837792.2018.1505379", body: ["Friis, I., Gilbert, M. G., Paton, A. J., Weber, O., van Breugel, P., & Demissew, S. (2018). The Gerire Hills, a SE Ethiopian outpost of the transitional semi-evergreen bushland: Vegetation, endemism and three new species, Croton elkerensis (Euphorbiaceae), Gnidia elkerensis (Thymelaeaceae), and Plectranthus spananthus (Lamiaceae). Webbia, 73(2), 203-223. [https://edu.nl/x74tj](https://doi.org/10.1080/00837792.2018.1505379)."] },
        { title: "Intermediate evergreen Afromontane forest (2018)", year: "2018", tags: "paper,geo", url: "https://doi.org/10.1127/phyto/2018/0207", body: ["Berhanu, A., Demsew, S., Woldu, Z., Friis, I., & van Breugel, P. (2018). Intermediate evergreen Afromontane forest (IAF) in northwestern Ethiopia: Observations, description and modelling its potential distribution. Phytocoenologia, 351-367. [https://edu.nl/w9t7n](https://doi.org/10.1127/phyto/2018/0207)."] },
      ],
    },
    {
      key: "degrees", title: "Degrees", nl: "Opleiding", entryType: "education", jsonResume: "education",
      entries: [
        { title: "PhD — Copenhagen University", cvId: "phd-degree", degree: "PhD", area: "Forest, Nature and Biomass", title_long: "Doctor of Philosophy in Forest, Nature and Biomass", institution: "Copenhagen University", start: "2010", end: "2016",
          body: ["Dissertation: The potential natural vegetation of eastern Africa; distribution, conservation and future changes."] },
        { title: "MSc — Wageningen University", cvId: "msc-degree", degree: "MSc", area: "Agricultural and Natural Environmental Sciences", title_long: "Master of Agricultural and Natural Environmental Sciences", institution: "Wageningen University", start: "1990", end: "1996",
          body: ["Specialization in Tropical Forestry Ecology and Silviculture. Graduated with distinction."] },
      ],
    },
    {
      key: "short_courses", title: "Short courses", nl: "Cursussen", entryType: "normal", jsonResume: "certificates",
      entries: [
        { title: "Basis qualification Examination", name: "Basis qualification Examination", date: "2018", tags: "teaching", body: ["HAS green academy"] },
        { title: "Basis qualification Education", name: "Basis qualification Education", date: "2018", tags: "teaching", body: ["HAS green academy"] },
        { title: "Spatial decision support system", name: "Spatial decision support system", date: "2006", tags: "geo", body: ["Geo‑information Science and Earth Observation (ITC)"] },
        { title: "Predictive modelling of species distribution", name: "Methods and tools for the predictive modelling of species distribution", date: "2002", tags: "geo", body: ["Centre of Environmental References and Information (CRIA)"] },
        { title: "Leading and managing for collaborative advantage", name: "Leading and managing for collaborative advantage", date: "2001", body: ["Organizational Change Program for the CGIAR Centers and the Training Resources Group"] },
        { title: "Project work and negotiation", name: "Project work and negotiation", date: "2001", body: ["KLV"] },
        { title: "ArcInfo", name: "ArcInfo", date: "1998", tags: "geo", body: ["Esri Hi-Tech House, Damascus, Syria"] },
      ],
    },
    {
      key: "skills", title: "Skills", nl: "Vaardigheden", entryType: "text", jsonResume: "skills",
      entries: [
        { title: "Tools", body: ["Proficient in a wide range of statistical, geospatial and database tools."] },
        { title: "Programming", body: ["Proficient in R, experienced in Python, SQL, HTML, CSS."] },
        { title: "Spatial analysis", body: ["Experienced in spatial data analysis and modelling in multiple application domains."] },
        { title: "Collaboration", body: ["Track record of collaboration in interdisciplinary and multicultural teams on research and development projects."] },
      ],
    },
    {
      key: "soft_skills", title: "Soft skills", nl: "Persoonlijke vaardigheden", entryType: "bullet", jsonResume: "skills",
      entries: [
        { title: "Critical and analytical thinking", body: ["Critical and analytical thinking"] },
        { title: "Adaptable and creative", body: ["Adaptable and creative"] },
        { title: "Motivated and committed", body: ["Motivated and committed"] },
        { title: "Enthusiastic and passionate", body: ["Enthusiastic and passionate"] },
      ],
    },
  ],

  variants: [
    {
      title: "Academic EN (full)",
      spec: {
        lang: "en",
        template: "modern",
        style: { main: "#274232", accent: "#157F3F", font: "Lato" },
        main: ["profile", "experience", "extracurricular", "readers", { section: "publications", title: "Publications since 2018", since: 2018 }],
        sidebar: ["contact", "degrees", "short_courses", "skills", "soft_skills"],
        rendercv: { design: { theme: "classic" } },
      },
    },
    {
      title: "Geo & teaching NL (2 pages)",
      spec: {
        lang: "nl",
        template: "modern",
        style: { main: "#274232", accent: "#157F3F", font: "Lato" },
        include_tags: ["geo", "teaching"],
        main: ["profile", { section: "experience", since: 2004 }, "extracurricular", { section: "publications", since: 2018, max: 5, intro: false }],
        sidebar: ["contact", "degrees", { section: "short_courses", max: 4 }, "skills"],
        rendercv: { design: { theme: "moderncv" } },
      },
    },
  ],
};

/* ──────────────────────────────────────────────────────────────────────────── */

const escapeHtml = (s) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Inline markdown (links, **bold**, *italic*) -> HTML.
const md = (s) =>
  escapeHtml(s)
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

const htmlBody = (paragraphs = [], items = []) =>
  paragraphs.map((p) => `<p>${md(p)}</p>`).join("") +
  (items.length ? `<ul>${items.map((i) => `<li>${md(i)}</li>`).join("")}</ul>` : "");

const textNote = (parentNoteId, title, content, icon) => {
  const { note } = api.createNewNote({ parentNoteId, title, type: "text", content: content || "" });
  if (icon) note.setLabel("iconClass", icon);
  return note;
};

// Entry fields copied 1:1 to labels (title_long is stored as #title).
const ENTRY_LABELS = ["cvId", "position", "company", "institution", "degree", "area", "name", "location", "start", "end", "date", "year", "tags", "url"];

function seed() {
  if (api.searchForNotes("#cvRoot").length) {
    api.log("cv-seed: a #cvRoot note already exists; nothing created.");
    return "A #cvRoot note already exists; nothing created.";
  }
  const parent = api.startNote.getParentNotes()[0];

  const root = textNote(parent.noteId, "CV", "<p>Single source for all CV variants. Use the CV button in the launch bar to build a variant.</p>", "bx bx-id-card");
  root.setLabel("cvRoot");

  const p = SEED.profile;
  const profile = textNote(root.noteId, "Profile", htmlBody(p.body), "bx bx-user");
  profile.setLabel("cvProfile");
  for (const [k, v] of Object.entries(p.labels)) profile.setLabel(k, v);
  for (const link of p.links) profile.addLabel("link", link);

  const sectionsFolder = textNote(root.noteId, "Sections", "", "bx bx-list-ul");
  for (const s of SEED.sections) {
    const sec = textNote(sectionsFolder.noteId, s.title, htmlBody(s.intro || []), "bx bx-folder");
    sec.setLabel("cvSection");
    sec.setLabel("cvKey", s.key);
    sec.setLabel("entryType", s.entryType);
    if (s.jsonResume) sec.setLabel("jsonResume", s.jsonResume);
    if (s.nl) sec.setLabel("cvTitle_nl", s.nl);
    for (const e of s.entries) {
      const entry = textNote(sec.noteId, e.title, htmlBody(e.body || [], e.items || []), "bx bx-file");
      for (const k of ENTRY_LABELS) if (e[k] != null && e[k] !== "") entry.setLabel(k, e[k]);
      if (e.title_long) entry.setLabel("title", e.title_long);
    }
  }

  const variantsFolder = textNote(root.noteId, "Variants", "", "bx bx-copy-alt");
  for (const v of SEED.variants) {
    const { note } = api.createNewNote({
      parentNoteId: variantsFolder.noteId,
      title: v.title,
      type: "code",
      mime: "application/json",
      content: JSON.stringify(v.spec, null, 2),
    });
    note.setLabel("cvVariant");
  }

  textNote(root.noteId, "Templates",
    "<p>Optional CSS code notes labelled <code>#cvTemplate=&lt;name&gt;</code>. Add <code>#cvExtends=modern</code> to append to the built-in template instead of replacing it. Reference a template from a variant with <code>\"template\": \"&lt;name&gt;\"</code>.</p>",
    "bx bx-palette");

  api.log("cv-seed: CV tree created.");
  return "CV tree created.";
}

seed();
