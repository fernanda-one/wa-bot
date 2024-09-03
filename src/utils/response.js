const responseSuccess = (res, status_code = 200, message, data = null) => {
  return res.status(200).json({
    status_code,
    message,
    data
  });
};

const responseError = (res, error, status_code = 500) => {
  return res.status(200).json({
    status_code,
    error
  });
};

module.exports = { responseError, responseSuccess };
