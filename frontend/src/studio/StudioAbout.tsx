import { repositoryUrl, teamContributions } from "./credits";
import "./StudioAbout.css";

export function StudioAbout() {
  return (
    <details className="studio-about">
      <summary>About ExitZero</summary>
      <div className="studio-about-content">
        <dl className="studio-about-facts">
          <div>
            <dt>Project</dt>
            <dd>ExitZero</dd>
          </div>
          <div>
            <dt>Team</dt>
            <dd>Kent Brogrammers</dd>
          </div>
          <div>
            <dt>Year</dt>
            <dd>2026</dd>
          </div>
          <div>
            <dt>Event</dt>
            <dd>Stark State Hackathon</dd>
          </div>
        </dl>
        <a href={repositoryUrl} target="_blank" rel="noreferrer">
          GitHub repository ↗
        </a>
        <h4>Project responsibilities</h4>
        <ul className="studio-about-team">
          {teamContributions.map(({ name, area, contribution }) => (
            <li key={name}>
              <strong>{name}</strong>
              <span>{area}</span>
              <p>{contribution}</p>
            </li>
          ))}
        </ul>
        <p className="studio-about-limitation">
          Experimental simulation prototype. Not a certified emergency planning
          tool.
        </p>
      </div>
    </details>
  );
}
