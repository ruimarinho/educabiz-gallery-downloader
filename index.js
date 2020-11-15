
/**
 * Module dependencies.
 */

const { pipeline } = require('stream');
const argv = require('minimist')(process.argv.slice(2));
const dayjs = require('dayjs');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const progressBar = require('cli-progress');
const qs = require('querystring');

/**
 * Extend dayjs with plugins.
 */

dayjs.extend(require('dayjs/plugin/customParseFormat'));
dayjs.extend(require('dayjs/plugin/utc'));

/**
 * Configuration.
 */

const {
  EDUCABIZ_SLUG,
  EDUCABIZ_CHILD_ID,
  EDUCABIZ_USERNAME,
  EDUCABIZ_PASSWORD
} = process.env;

/**
 * Base URL for requests.
 */

const baseUrl = `https://${EDUCABIZ_SLUG}.educabiz.com`;

/**
 * Default headers including a nulled cookie jar.
 */

const headers = {
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  cookie: null
};

/**
 * Fetch authentication headers.
 */

async function authenticate(username, password) {
  // Generate anonymous session id and CSRF token (`authenticityToken`).
  const html = await fetch(`${baseUrl}`);
  const { groups: { sessionId } } = html.headers.raw()['set-cookie'].find(cookie => /PLAY_SESSION/.test(cookie)).match(/(?<sessionId>.*); Version=/);
  const { groups: { authenticityToken } } = (await html.text()).match(/"authenticityToken" value="(?<authenticityToken>.*)"/);

  // Authenticate anonymous session id.
  const params = new URLSearchParams();
  params.append('authenticityToken', authenticityToken);
  params.append('username', username);
  params.append('password', password);

  // POST to /authenticate but trap redirect to capture authenticated headers.
  const authorization = await fetch(`${baseUrl}/authenticate`, {
    headers: {
      cookie: `PLAY_SESSION='${sessionId}-___AT=${authenticityToken}'`,
    },
    redirect: 'manual',
    method: 'POST',
    body: params
  });

  const cookieHeader = authorization.headers.raw()['set-cookie'];

  if (cookieHeader.find(cookie => /security\.forbidden\.unknown/.test(cookie))) {
    throw new Error('Wrong credentials. Please make sure EDUCABIZ_USERNAME and EDUCABIZ_PASSWORD are set correctly.')
  }

  const { groups: { authenticatedCookie } } = cookieHeader.find(cookie => /PLAY_SESSION/.test(cookie)).match(/(?<authenticatedCookie>.*); Version=/);

  return authenticatedCookie;
}

/**
 * Photo gallery paginator.
 */

async function requestGallery(childId, page) {
  console.log(`Fetching gallery page ${page}...`);

  const body = `childId=${childId}&page=${page}`;

	return await fetch(`${baseUrl}/childctrl/childgalleryloadmore`, { headers, body, method: 'POST' });
}

/**
 * Request zip creation for a given set of picture ids.
 */

async function createZip(pictureIds) {
  console.log('Preparing to create zip...');

  const body = pictureIds.reduce((accumulator, element) => (`${accumulator}&pictureId%5B%5D=${element}`), 'isAlbum=false');
	const response = await fetch(`${baseUrl}/schoolctrl/createzip`, { headers, body, method: 'POST' });
  const html = await response.text();
  const { groups: { notificationId } } = html.match(/setTimeout\(pollNext\((?<notificationId>[0-9]{7})\)\, 1000\)/);

  return notificationId;
}

/**
 * Fetch progress of a zip creation job.
 */

async function getZipProgress(notificationId) {
	return await fetch(`${baseUrl}/notifications/${notificationId}/progress`, { headers });
}

(async () => {
  const authenticatedCookie = await authenticate(EDUCABIZ_USERNAME, EDUCABIZ_PASSWORD);

  // Add authenticated cookie to the cookie jar.
  headers.cookie = authenticatedCookie;

  let since;
  if (!argv.since) {
    argv.since = '1970-01-01';
  } else {
    console.log(`Only downloading photos uploaded on or after ${argv.since}`);
  }

  since = dayjs.utc(argv.since);

  let hasPaginationEnded = false;
  let page = 1;
  let picturesIds = [];

  while (!hasPaginationEnded) {
    const response = await requestGallery(EDUCABIZ_CHILD_ID, page);

    if (response.status != 200) {
      hasPaginationEnded = true;
      console.error(`There was an issue while fetching gallery items (${response.status})`);
      return;
    }

    page++;

    const gallery = await response.json();

    if (gallery.pictures.length === 0) {
      hasPaginationEnded = true;
    }

    const ids = gallery.pictures
      .filter(element => !dayjs(element.shortDate, 'DD-MM-YYYY').isBefore(since))
      .map(element => element.imgLargeId);

    // Concat ids to existing queue.
    picturesIds.push.apply(picturesIds, ids);

    console.log(`Queuing ${ids.length} photos for a total of ${picturesIds.length} pictures`);

    if (gallery.pictures.some(element => dayjs(element.shortDate, 'DD-MM-YYYY').isBefore(since))) {
      console.log(`No additional pages contain pictures before requested date`);
      hasPaginationEnded = true;
      break;
    }
  }

  if (picturesIds.length === 0) {
    console.log('Sorry, no pictures found')
    return;
  }

  // Request zip for picture ids.
  const notificationId = await createZip(picturesIds);

  let isZipReady = false;
  let downloadUrl;
  let bar;

  while (!isZipReady) {
    const progress = await (await getZipProgress(notificationId)).json();

    if (!bar) {
      bar = new progressBar.SingleBar({}, progressBar.Presets.shades_classic)
      bar.start(progress.total, progress.processed);
    } else {
      bar.update(progress.processed);
    }

    if (progress.finished) {
      bar.stop();
      isZipReady = true
      downloadUrl = qs.unescape(progress.details.resultLocation);
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (!downloadUrl) {
    console.error('Unable to determine download URL');
  }

  const filename = path.parse(new URL(qs.unescape(downloadUrl)).pathname).base;

  console.log('Downloading zip...');

  const response = await fetch(downloadUrl)

  await pipeline(response.body, fs.createWriteStream(filename))

  console.log(`Finished downloading ${filename}!`);
})().catch(error => {
  console.error(error);
});
