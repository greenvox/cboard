import JSZipUtils from 'jszip-utils';
import JSZip from 'jszip';
import shortid from 'shortid';
import axios from 'axios';
import { API_URL } from '../../../constants';
import { IMPORT_PATHS, CBOARD_EXT_PREFIX } from './Import.constants';
import API from '../../../api';

function toCamelCase(scString = '') {
  const find = /(_\w)/g;
  const convertFn = matches => matches[1].toUpperCase();

  return scString.replace(find, convertFn);
}

async function readZip(file) {
  const zipBlob = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = event => {
      if (event.target.readyState === 2) {
        try {
          resolve(new Blob([reader.result]));
        } catch (err) {
          resolve(null);
        }
      }
    };
    reader.readAsArrayBuffer(file);
  });

  if (zipBlob === null) {
    return Promise.reject();
  }

  const filePath = URL.createObjectURL(zipBlob);
  return new Promise(resolve => {
    JSZipUtils.getBinaryContent(filePath, (err, data) => {
      if (err) {
        resolve(err);
      } else {
        resolve(JSZip.loadAsync(data));
      }
    });
  });
}

function obfButtonToCboardButton(button) {
  const cboardButton = {
    id: button.id || shortid.generate(),
    label: button.label || ''
  };

  if (button['background_color']) {
    cboardButton.backgroundColor = button['background_color'];
  }

  if (button['border_color']) {
    cboardButton.borderColor = button['border_color'];
  }

  if (button.vocalization) {
    cboardButton.vocalization = button.vocalization;
  }

  if (button.action) {
    cboardButton.action = button.action;
  }

  return cboardButton;
}

async function translateBoard(board = {}, intl) {
  if (
    board.locale &&
    board.locale.toLowerCase() !== intl.locale &&
    board.tiles
  ) {
    const labels = [];
    const vocalizations = [];

    board.tiles.forEach(tile => {
      if (!tile.labelKey && tile.label) {
        labels.push(tile.label);
      }

      if (tile.vocalization) {
        vocalizations.push(tile.vocalization);
      }
    });

    let i10nLabels = {};
    let i10nVocalizations = {};

    if (labels.length) {
      i10nLabels = await fetchTranslations(labels, board.locale, intl.locale);
    }

    if (vocalizations.length) {
      i10nVocalizations = await fetchTranslations(
        vocalizations,
        board.locale,
        intl.locale
      );
    }

    board.tiles.forEach(tile => {
      if (!tile.labelKey && tile.label) {
        tile.originalLabel = tile.label;
        tile.label = i10nLabels[tile.label] || tile.label;
      }

      if (tile.vocalization) {
        tile.originalVocalization = tile.vocalization;
        tile.vocalization =
          i10nVocalizations[tile.vocalization] || tile.vocalization;
      }
    });

    board.originalLocale = board.locale;
    board.locale = intl.locale;
  }

  return board;
}

async function translateBoards(boards = [], intl) {
  return Promise.all(boards.map(async board => translateBoard(board, intl)));
}

async function fetchTranslations(labels, boardLocale, currentLocale) {
  let translatedData = {};
  try {
    const { data } = await axios.post(`${API_URL}/translate`, {
      labels,
      from: boardLocale,
      to: currentLocale
    });
    translatedData = labels.reduce((prev, current) => {
      prev[current] =
        data[current] && data[current].text ? data[current].text : current;
      return prev;
    }, {});
  } catch (e) {}
  return translatedData;
}

async function getTilesData(obfBoard, boards = {}, images = {}) {
  const tiles = await Promise.all(
    obfBoard.buttons.map(async button => {
      const tileButton = obfButtonToCboardButton(button);

      if (button['load_board']) {
        const loadBoardData = button['load_board'];
        if (loadBoardData.path && boards[loadBoardData.path]) {
          tileButton.loadBoard = boards[loadBoardData.path].id;
        }
      }

      if (button['image_id']) {
        let imageID = button['image_id'];
        let image = obfBoard.images.find(image => image.id === imageID);

        if (image) {
          let imageData = image.data || null;
          if (image['content_type'] && image.path && images[image.path]) {
            imageData = `data:${image['content_type']};base64,${
              images[image.path]
            }`;
          }

          if (image.url) {
            tileButton.image = image.url;
          }

          if (imageData) {
            let url = imageData;
            try {
              const apiURL = await API.uploadFromDataURL(url, imageID, true);
              url = apiURL || url;
            } catch (e) {}
            tileButton.image = url;
          }
        }
      }

      const extKeys = Object.keys(button).filter(k =>
        k.startsWith(CBOARD_EXT_PREFIX)
      );
      extKeys.forEach(key => {
        const tileKey = toCamelCase(key.slice(CBOARD_EXT_PREFIX.length));
        tileButton[tileKey] = button[key];
      });

      return tileButton;
    })
  );

  return tiles;
}

async function obfToCboard(obfBoard, intl, boards = {}, images = {}) {
  let tiles = [];

  if (obfBoard.buttons) {
    tiles = await getTilesData(obfBoard, boards, images);
  }

  let board = {
    id: obfBoard.id || obfBoard.name || shortid.generate(),
    tiles
  };

  const extKeys = Object.keys(obfBoard).filter(k =>
    k.startsWith(CBOARD_EXT_PREFIX)
  );
  extKeys.forEach(key => {
    const tileKey = toCamelCase(key.slice(CBOARD_EXT_PREFIX.length));
    board[tileKey] = obfBoard[key];
  });

  if (!board.nameKey && obfBoard.name) {
    board.name = obfBoard.name;
  }

  if (obfBoard.locale) {
    board.locale = obfBoard.locale;
  }

  board = await translateBoard(board, intl);

  return board;
}

export async function cboardImportAdapter(file, intl) {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = async event => {
      if (event.target.readyState === 2) {
        try {
          const jsonFile = JSON.parse(reader.result);
          const boards = await translateBoards(jsonFile, intl);
          resolve(boards);
        } catch (err) {
          reject(err);
        }
      }
    };
    reader.readAsText(file);
  });
}

export async function obzImportAdapter(file, intl) {
  const zipFile = await readZip(file);
  if (typeof zipFile !== 'object') {
    throw new Error(zipFile);
  }

  const keys = Object.keys(zipFile.files);
  const boardKeys = keys.filter(
    k => !zipFile.files[k].dir && k.startsWith(IMPORT_PATHS.boards)
  );
  const imageKeys = keys.filter(
    k => !zipFile.files[k].dir && k.startsWith(IMPORT_PATHS.images)
  );

  const boards = {};
  const images = {};

  await Promise.all(
    keys.map(async k => {
      const isBoard = boardKeys.indexOf(k) >= 0;

      if (!isBoard && imageKeys.indexOf(k) < 0) {
        return Promise.resolve();
      }

      const type = isBoard ? 'text' : 'base64';
      let result = null;
      try {
        result = await zipFile.files[k].async(type);

        if (isBoard) {
          boards[k] = JSON.parse(result);
        } else {
          images[k] = result;
        }
      } catch (e) {}

      return result;
    })
  );

  const cboardBoards = [];
  for (let key in boards) {
    const board = await obfToCboard(boards[key], intl, boards, images);
    cboardBoards.push(board);
  }

  return cboardBoards;
}

export async function obfImportAdapter(file, intl) {
  const reader = new FileReader();
  const jsonFile = await new Promise(resolve => {
    reader.onload = event => {
      if (event.target.readyState === 2) {
        try {
          const jsonFile = JSON.parse(reader.result);
          resolve(jsonFile);
        } catch (err) {
          resolve(err);
        }
      }
    };
    reader.readAsText(file);
  });

  if (typeof jsonFile !== 'object') {
    throw new Error(jsonFile);
  }

  const board = await obfToCboard(jsonFile, intl);

  return [board];
}

export async function requestQuota(json) {
  const size = JSON.stringify(json).length;
  if (size > 1024 * 1024 * 4) {
    const requestQuotaAvailable =
      navigator &&
      navigator.webkitPersistentStorage &&
      navigator.webkitPersistentStorage.requestQuota;
    if (requestQuotaAvailable) {
      try {
        await new Promise((resolve, reject) => {
          navigator.webkitPersistentStorage.requestQuota(
            size * 2,
            grantedSize => {
              if (grantedSize >= size) {
                resolve();
              } else {
                reject(`Granted size is below the limit: ${grantedSize}`);
              }
            },
            err => reject(`Request quota error: ${err}`)
          );
        });
      } catch (e) {
        throw new Error(e);
      }
    } else {
      throw new Error("Can't request quota");
    }
  }

  return size;
}
